#!/usr/bin/env python3
"""show-ai-bench-results

Usage:
    python main.py --init        # one-time setup: venv + deps + llama-benchy
    python main.py               # serve the web UI on http://127.0.0.1:8585
    python main.py --start-all   # run all servers x all profiles headlessly, print summary
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parent
REQUIREMENTS = APP_ROOT / "requirements.txt"
DEFAULT_CONFIG = APP_ROOT / "servers.conf"
DEFAULT_RESULTS = APP_ROOT / "results"


# --------------------------------------------------------------------- setup


def cmd_init(args) -> int:
    print("[init] setting up show-ai-bench-results ...")

    venv = APP_ROOT / ".venv"
    if not (venv / "bin" / "python").exists():
        print(f"[init] creating virtualenv {venv}")
        _run([sys.executable, "-m", "venv", str(venv)])
    pip = venv / "bin" / "pip"
    print("[init] installing python dependencies")
    _run([str(pip), "install", "-r", str(REQUIREMENTS)])
    print("[init] installing llama-benchy (PyPI; git fallback)")
    if _run([str(pip), "install", "-U", "llama-benchy"]) != 0:
        _run([str(pip), "install", "-U",
              "git+https://github.com/eugr/llama-benchy"])
    from showaibench.benchmarker import find_tool

    print(f"[init] llama-benchy at {find_tool()}")
    print("\n[init] done. Next steps:")
    print("  python main.py               # web UI on http://127.0.0.1:8585")
    print("  python main.py --start-all   # run everything headlessly")
    return 0


# ------------------------------------------------------------------- running


def _run(cmd: list[str], **kw) -> int:
    import subprocess

    print("  $", " ".join(str(c) for c in cmd))
    try:
        return subprocess.run(cmd, check=False, **kw).returncode
    except FileNotFoundError as exc:
        print(f"[init] command not found: {exc}")
        return 1


def make_manager(args) -> tuple:
    from showaibench.benchmarker import find_tool
    from showaibench.config import load_servers
    from showaibench.runner import RunManager

    config_path = Path(args.config)
    if not config_path.exists():
        print(f"error: config not found: {config_path}")
        raise SystemExit(1)
    servers = load_servers(config_path)
    tool = find_tool(args.tool)  # raises with --init hint
    manager = RunManager(args.results_dir, tool, servers)
    return manager


def cmd_start_all(args) -> int:
    from showaibench.config import PROFILES, PROFILE_PRESETS

    manager = make_manager(args)
    settings = {
        "runs": args.runs,
        "depths": args.depths,
        "concurrency": args.concurrency,
    }
    run_id = manager.start(list(manager.servers.keys()), PROFILES, settings=settings)
    est = _estimate_minutes(settings, PROFILES)
    print(f"[run] {run_id}: {len(manager.servers)} servers x {len(PROFILES)} profiles "
          f"(parallel across servers, serial profiles; ~{est:.0f} min). "
          f"runs={args.runs} depths={args.depths} concurrency={args.concurrency}")
    while True:
        status = manager.status(run_id)
        done = sum(1 for r in status["rows"] if r["status"] in ("ok", "error"))
        total = len(status["rows"])
        print(f"[run] {done}/{total} combinations finished ...", flush=True)
        if status["status"] != "running":
            break
        time.sleep(10)
    _print_summary(manager.load_run(run_id), run_id)
    print(f"\nresults saved to {Path(args.results_dir) / run_id}\n"
          f"view them with: python main.py")
    return 0


def _estimate_minutes(settings: dict, profiles) -> float:
    """Rough wall-time estimate per server (profiles serial, servers parallel)."""
    depths = [int(d) for d in str(settings.get("depths", "0")).replace(",", " ").split()] or [0]
    total_s = 0.0
    for profile in profiles:
        from showaibench.config import PROFILE_PRESETS

        preset = PROFILE_PRESETS[profile]
        run_s = preset["pp"] / 1000.0 + preset["tg"] / 80.0 + 2.0  # pps + decode + overhead
        total_s += len(depths) * int(settings["runs"]) * run_s
    return total_s / 60.0


def _print_summary(doc, run_id) -> None:
    if doc is None:
        print("[run] no results were persisted")
        return
    print(f"\n=== {run_id} summary ===")
    for sname, profiles in doc["results"].items():
        for profile, entry in profiles.items():
            if entry.get("status") != "ok":
                print(f"{sname:14s} {profile:16s} ERROR: {entry.get('error')}")
                continue
            rows = entry.get("rows") or []
            if not rows:
                print(f"{sname:14s} {profile:16s} no rows")
                continue
            best = max((r for r in rows if r.get("tg_tps")), default=rows[0], key=lambda r: r["tg_tps"])
            print(
                f"{sname:14s} {profile:16s} {best['shape']} | "
                f"pp={best['pp_tps']:.0f} tok/s | tg={best['tg_tps']:.1f} tok/s | "
                f"ttfr={best['ttfr_ms'] or 0:.0f} ms | e2e_ttft={best['e2e_ttft_ms'] or 0:.0f} ms"
            )


# ---------------------------------------------------------------------- CLI


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="show-ai-bench-results")
    parser.add_argument("--init", action="store_true", help="setup: venv + deps + llama-benchy")
    parser.add_argument("--start-all", action="store_true",
                        help="run all servers x all profiles headlessly (like selecting everything and pressing start)")
    parser.add_argument("--config", default=str(DEFAULT_CONFIG), help="servers.conf path")
    parser.add_argument("--results-dir", default=str(DEFAULT_RESULTS), help="results directory")
    parser.add_argument("--tool", default=None, help="llama-benchy executable path")
    parser.add_argument("--port", type=int, default=8585, help="web UI port (bound to 127.0.0.1)")
    parser.add_argument("--runs", type=int, default=3, help="runs per test shape (1-10)")
    parser.add_argument("--depths", default="0", help="context depths, space/comma separated (max 8)")
    parser.add_argument("--concurrency", type=int, default=1, help="concurrent requests per test (1-64)")
    args = parser.parse_args(argv)

    if args.init:
        return cmd_init(args)
    if args.start_all:
        return cmd_start_all(args)

    # default: serve web UI
    manager = make_manager(args)
    from showaibench.server import run_server

    print(f"show-ai-bench-results UI: http://127.0.0.1:{args.port}")
    run_server(manager, Path(args.config), port=args.port)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
