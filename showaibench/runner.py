"""Orchestration: benchmarks run in parallel across servers, serial across profiles.

Each completed run is persisted under `results/<run_id>/run.json` plus the raw
reports from llama-benchy so results survive app restarts.
"""

from __future__ import annotations

import json
import socket
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

from .benchmarker import BenchmarkError, log_name, run_benchmark
from .config import DEFAULT_SETTINGS, PROFILES, ServerConfig


def _now() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


@dataclass
class Run:
    id: str
    servers: dict[str, ServerConfig]
    profiles: list[str]
    started_at: str
    finished_at: str | None = None
    status: str = "running"  # running | done | error
    # server -> profile -> {status, error, rows, raw_file}
    results: dict = field(default_factory=dict)
    settings: dict = field(default_factory=dict)


class RunManager:
    def __init__(self, results_dir: str | Path, tool: Path, servers: dict[str, ServerConfig]):
        self.results_dir = Path(results_dir).resolve()
        self.results_dir.mkdir(parents=True, exist_ok=True)
        self.tool = Path(tool).resolve()
        self.servers = servers
        self._runs: dict[str, Run] = {}
        self._lock = threading.Lock()

    # ---------------------------------------------------------------- running

    @staticmethod
    def _normalize_settings(settings: dict) -> dict:
        settings = {**DEFAULT_SETTINGS, **(settings or {})}
        settings["runs"] = int(settings.get("runs", DEFAULT_SETTINGS["runs"]))
        settings["concurrency"] = int(settings.get("concurrency", DEFAULT_SETTINGS["concurrency"]))
        if not (1 <= settings["runs"] <= 10):
            raise ValueError("runs out of range (1-10)")
        if not (1 <= settings["concurrency"] <= 64):
            raise ValueError("concurrency out of range (1-64)")
        raw = settings.get("depths", "0")
        if isinstance(raw, str):
            raw = raw.replace(",", " ").split()
        depths = [int(d) for d in raw]
        if not depths:
            depths = [0]
        if len(depths) > 8:
            raise ValueError("too many depths (max 8)")
        settings["depths"] = depths
        return settings

    def start(self, server_names, profiles, settings=None) -> str:
        unknown = [s for s in server_names if s not in self.servers]
        if unknown:
            raise ValueError(f"unknown server(s): {', '.join(unknown)}")
        bad = [p for p in profiles if p not in PROFILES]
        if bad:
            raise ValueError(f"unknown profile(s): {', '.join(bad)}")
        if not server_names or not profiles:
            raise ValueError("select at least one server and one profile")

        settings = self._normalize_settings(settings)
        run_id = datetime.now().strftime("%Y%m%d-%H%M%S")
        suffix = 2
        while self._run_dir(run_id).exists():
            run_id = datetime.now().strftime("%Y%m%d-%H%M%S") + f"-{suffix}"
            suffix += 1

        run = Run(
            id=run_id,
            servers={n: self.servers[n] for n in server_names},
            profiles=list(profiles),
            started_at=_now(),
            settings=settings,
        )
        with self._lock:
            self._runs[run_id] = run
        threading.Thread(
            target=self._execute, args=(run,), daemon=True,
            name=f"bench-{run_id}",
        ).start()
        return run_id

    def _execute(self, run: Run) -> None:
        run_dir = self._run_dir(run.id)
        run_dir.mkdir(parents=True, exist_ok=True)

        with ThreadPoolExecutor(max_workers=max(1, len(run.servers))) as pool:
            futures = {
                pool.submit(self._server_worker, run, name, run_dir): name
                for name in run.servers
            }
            for fut in as_completed(futures):
                fut.result()  # per-profile errors are recorded, never raised

        with self._lock:
            run.finished_at = _now()
            run.status = "error" if any(
                run.results.get(s, {}).get(p, {}).get("status") == "error"
                for s in run.servers for p in run.profiles
            ) else "done"
        self._persist(run)

    def _server_worker(self, run: Run, server_name: str, run_dir: Path) -> None:
        server = run.servers[server_name]
        for profile in run.profiles:
            entry = {
                "status": "running",
                "error": None,
                "rows": None,
                "raw_file": None,
                "log_file": log_name(server.name, profile),
            }
            with self._lock:
                run.results.setdefault(server_name, {})[profile] = entry
            try:
                out = run_benchmark(self.tool, server, profile, run_dir, settings=run.settings)
                with self._lock:
                    entry["status"] = "ok"
                    entry["rows"] = out["rows"]
                    entry["raw_file"] = out["raw_file"]
                    entry["log_file"] = out["log_file"]
            except BenchmarkError as exc:
                with self._lock:
                    entry["status"] = "error"
                    entry["error"] = str(exc)
                    entry["log_file"] = exc.log_file or entry["log_file"]
            except Exception as exc:  # noqa: BLE001 - record and continue with next profile
                with self._lock:
                    entry["status"] = "error"
                    entry["error"] = str(exc)

    # ---------------------------------------------------------------- storage

    def _run_dir(self, run_id: str) -> Path:
        return self.results_dir / run_id

    def _doc(self, run: Run) -> dict:
        return {
            "id": run.id,
            "started_at": run.started_at,
            "finished_at": run.finished_at,
            "status": run.status,
            "servers": {n: s.as_json() for n, s in run.servers.items()},
            "profiles": run.profiles,
            "results": run.results,
            "settings": run.settings,
            "system": {"hostname": socket.gethostname()},
        }

    def _persist(self, run: Run) -> None:
        (self._run_dir(run.id) / "run.json").write_text(json.dumps(self._doc(run), indent=1))

    def status(self, run_id: str) -> dict:
        with self._lock:
            run = self._runs.get(run_id)
        if run is None:
            doc = self.load_run(run_id)
            if doc is None:
                raise KeyError(f"unknown run: {run_id}")
            return self._status_doc(doc)
        return self._status_doc(run)

    def _status_doc(self, obj) -> dict:
        if isinstance(obj, Run):
            servers = obj.servers
            results = obj.results
            profiles = obj.profiles
        else:  # persisted doc
            servers = obj["servers"]
            results = obj.get("results", {})
            profiles = obj["profiles"]
        run_id = obj.id if isinstance(obj, Run) else obj["id"]
        rows = []
        for sname in servers:
            for profile in profiles:
                entry = results.get(sname, {}).get(profile, {"status": "pending"})
                rows.append({
                    "server": sname,
                    "profile": profile,
                    "status": entry.get("status", "pending"),
                    "error": entry.get("error"),
                    "log_tail": self._log_tail(run_id, entry.get("log_file")),
                })
        return {
            "id": obj.id if isinstance(obj, Run) else obj["id"],
            "status": obj.status if isinstance(obj, Run) else obj["status"],
            "started_at": obj.started_at if isinstance(obj, Run) else obj["started_at"],
            "finished_at": obj.finished_at if isinstance(obj, Run) else obj["finished_at"],
            "rows": rows,
        }

    def _log_tail(self, run_id: str, log_file: str | None, limit: int = 1500) -> str | None:
        if not log_file:
            return None
        path = self._run_dir(run_id) / log_file
        try:
            if not path.is_file():
                return None
            return path.read_text(errors="replace").strip()[-limit:]
        except OSError:
            return None

    def list_runs(self) -> list[dict]:
        out = []
        with self._lock:
            live = [self._doc(r) for r in self._runs.values() if r.status == "running"]
        for doc in live:
            out.append({
                "id": doc["id"],
                "started_at": doc["started_at"],
                "finished_at": None,
                "status": "running",
                "servers": list(doc["servers"]),
                "profiles": doc["profiles"],
            })
        for run_json in sorted(self.results_dir.glob("*/run.json"), reverse=True):
            try:
                doc = json.loads(run_json.read_text())
            except (OSError, json.JSONDecodeError):
                continue
            out.append({
                "id": doc["id"],
                "started_at": doc.get("started_at"),
                "finished_at": doc.get("finished_at"),
                "status": doc.get("status"),
                "servers": list(doc.get("servers", {})),
                "profiles": doc.get("profiles", []),
            })
        return out

    def load_run(self, run_id: str) -> dict | None:
        with self._lock:
            run = self._runs.get(run_id)
            if run is not None:
                return self._doc(run)
        path = self._run_dir(run_id) / "run.json"
        if not path.exists():
            return None
        return json.loads(path.read_text())
