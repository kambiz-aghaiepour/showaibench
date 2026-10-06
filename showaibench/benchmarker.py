"""Adaptor for `llama-benchy` (OpenAI-compatible endpoint benchmarker).

Each benchmark runs in its own temporary working directory; the tool writes
the JSON report to the path given via `--save-result`, which we parse and
normalize into per-shape rows (pp/tg at context depth, mean +/- std).
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

from .config import PROFILE_PRESETS, ServerConfig

TOOL_NAME = "llama-benchy"
APP_ROOT = Path(__file__).resolve().parent.parent

# run_id -> live llama-benchy subprocesses (for the kill endpoint)
ACTIVE_PROCS: dict[str, list] = {}


def register_proc(run_id: str, proc) -> None:
    ACTIVE_PROCS.setdefault(run_id, []).append(proc)


def unregister_proc(run_id: str, proc) -> None:
    procs = ACTIVE_PROCS.get(run_id)
    if not procs:
        return
    try:
        procs.remove(proc)
    except ValueError:
        pass
    if not procs:
        ACTIVE_PROCS.pop(run_id, None)


def kill_run_procs(run_id: str) -> int:
    procs = ACTIVE_PROCS.pop(run_id, [])
    for proc in procs:
        try:
            proc.terminate()
        except OSError:
            pass
    return len(procs)


class BenchmarkError(RuntimeError):
    """llama-benchy failed; carries the name of its log file for live tailing."""

    def __init__(self, message: str, log_file: str | None = None):
        super().__init__(message)
        self.log_file = log_file


def log_name(server_name: str, label: str) -> str:
    return f"{_sanitize(server_name)}__{_sanitize(label)}.log"


def find_tool(path: str | Path | None = None) -> Path:
    """Locate the llama-benchy executable."""
    candidates = []
    if path:
        candidates.append(Path(path))
    candidates.append(APP_ROOT / ".venv" / "bin" / TOOL_NAME)
    which = shutil.which(TOOL_NAME)
    if which:
        candidates.append(Path(which))
    for cand in candidates:
        if cand.is_file():
            return cand.resolve()
    raise FileNotFoundError(
        f"llama-benchy not found - run: python main.py --init"
    )


def _sanitize(name) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]", "_", str(name or "manual"))


def _base_url(url: str) -> str:
    url = url.strip().rstrip("/")
    if not url.endswith("/v1"):
        url += "/v1"
    return url


def build_command(
    tool: Path,
    server: ServerConfig,
    profile: str,
    settings: dict,
    save_path: Path,
) -> list[str]:
    preset = PROFILE_PRESETS[profile]
    depths = [str(d) for d in settings.get("depths", [0])]
    cmd = [
        str(tool),
        "--base-url", _base_url(server.url),
        "--model", server.model,
        "--tokenizer", server.tokenizer_name,
        "--pp", str(preset["pp"]),
        "--tg", str(preset["tg"]),
        "--depth", *depths,
        "--runs", str(settings["runs"]),
        "--concurrency", str(settings["concurrency"]),
        "--latency-mode", "generation",
        "--format", "json",
        "--save-result", str(save_path),
        "--skip-coherence",
    ]
    if server.api_key:
        cmd += ["--api-key", server.api_key]
    if server.extra_body:
        cmd += ["--extra-body", server.extra_body]
    return cmd


def _tail(proc: subprocess.CompletedProcess, limit: int = 1500) -> str:
    combined = (proc.stdout or "") + "\n" + (proc.stderr or "")
    return combined.strip()[-limit:]


def _tool_env() -> dict:
    """Base env for llama-benchy; adds the user's HF token (for tokenizer
    downloads) if present locally and not already exported."""
    env = os.environ.copy()
    # llama-benchy prints via plain print(); without this its stdout is
    # block-buffered when redirected to a file, so the live log tail stays
    # empty until the process exits.
    env["PYTHONUNBUFFERED"] = "1"
    if not env.get("HF_TOKEN") and not env.get("HF_HUB_TOKEN"):
        tok_file = Path.home() / "Documents" / "huggingface"
        if tok_file.is_file():
            token = tok_file.read_text().strip()
            if token:
                env["HF_TOKEN"] = token
    return env


def _stat(obj: dict, key: str) -> dict:
    entry = obj.get(key) or {}
    std = entry.get("std")
    return {
        "mean": _num(entry.get("mean")),
        "std": _num(std),
    }


def _num(value, default=None):
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def aggregate(report: dict, server_name: str, profile: str) -> list[dict]:
    """Convert llama-benchy JSON into per-shape metric rows (for bar charts)."""
    rows = []
    for raw in report.get("benchmarks", []):
        pp = int(raw.get("prompt_size", 0))
        tg = int(raw.get("response_size", 0))
        depth = int(raw.get("context_size", 0))
        concurrency = int(raw.get("concurrency", 1))
        prefix = "ctx_pp" if raw.get("is_context_prefill_phase") else None
        if prefix:
            shape = f"{prefix}{pp}"
        else:
            shape = f"pp{pp}/tg{tg}"
        if concurrency > 1:
            shape += f" (x{concurrency})"
        if depth:
            shape += f" @ d{depth}"
        rows.append({
            "shape": shape,
            "pp": pp,
            "tg": tg,
            "depth": depth,
            "concurrency": concurrency,
            "pp_tps": _num((raw.get("pp_throughput") or {}).get("mean")),
            "pp_tps_std": _num((raw.get("pp_throughput") or {}).get("std")),
            "tg_tps": _num((raw.get("tg_throughput") or {}).get("mean")),
            "tg_tps_std": _num((raw.get("tg_throughput") or {}).get("std")),
            "peak_tps": _num((raw.get("peak_throughput") or {}).get("mean")),
            "peak_tps_std": _num((raw.get("peak_throughput") or {}).get("std")),
            "ttfr_ms": _num((raw.get("ttfr") or {}).get("mean")),
            "ttfr_ms_std": _num((raw.get("ttfr") or {}).get("std")),
            "est_ppt_ms": _num((raw.get("est_ppt") or {}).get("mean")),
            "est_ppt_ms_std": _num((raw.get("est_ppt") or {}).get("std")),
            "e2e_ttft_ms": _num((raw.get("e2e_ttft") or {}).get("mean")),
            "e2e_ttft_ms_std": _num((raw.get("e2e_ttft") or {}).get("std")),
        })
    return rows


def run_benchmark(
    tool: Path,
    server: ServerConfig,
    profile: str,
    workdir: Path,
    settings: dict,
) -> dict:
    """Run one (server, profile) benchmark; return {'rows': [...], 'raw_file': str}."""
    workdir = Path(workdir)
    workdir.mkdir(parents=True, exist_ok=True)
    label = profile or "manual"
    log_file = log_name(server.name, label)
    log_path = workdir / log_file

    with tempfile.TemporaryDirectory(dir=workdir, prefix=f"{_sanitize(server.name)}-") as tmp:
        save_path = Path(tmp) / "result.json"
        cmd = build_command(tool, server, profile, settings, save_path)
        with open(log_path, "wb") as logf:
            proc = subprocess.Popen(
                cmd, cwd=tmp, stdout=logf, stderr=subprocess.STDOUT, env=_tool_env()
            )
            register_proc(workdir.name, proc)
            try:
                rc = proc.wait()
            finally:
                unregister_proc(workdir.name, proc)
        if not save_path.exists():
            log_text = log_path.read_text(errors="replace") if log_path.exists() else ""
            raise BenchmarkError(
                f"[{server.name}/{label}] no report produced (exit={rc}): "
                f"{log_text.strip()[-3000:]}",
                log_file=log_file,
            )
        report = json.loads(save_path.read_text())
        raw_name = f"{_sanitize(server.name)}__{_sanitize(label)}.json"
        shutil.copy2(save_path, workdir / raw_name)

    rows = aggregate(report, server.name, profile)
    if not rows:
        raise BenchmarkError(
            f"[{server.name}/{label}] report contains no results", log_file=log_file
        )
    return {"rows": rows, "raw_file": raw_name, "log_file": log_file}
