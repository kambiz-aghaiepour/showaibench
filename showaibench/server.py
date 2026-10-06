"""FastAPI web UI - binds to 127.0.0.1 only."""

from __future__ import annotations

import json
import threading
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .config import PROFILES, load_servers
from .runner import RunManager

STATIC_DIR = Path(__file__).parent / "static"


def create_app(manager: RunManager, config_path: Path):
    app = FastAPI(title="show-ai-bench-results")

    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

    @app.middleware("http")
    async def no_cache_static(request, call_next):
        response = await call_next(request)
        if request.url.path.startswith("/static"):
            response.headers["Cache-Control"] = "no-store"
        return response

    @app.get("/")
    def index():
        return FileResponse(STATIC_DIR / "index.html")

    @app.get("/api/servers")
    def servers():
        return {"servers": [s.as_json() for s in manager.servers.values()]}

    @app.get("/api/profiles")
    def profiles():
        return {"profiles": PROFILES}

    @app.post("/api/run")
    def start_run(body: dict):
        try:
            run_id = manager.start(
                body.get("servers", []),
                body.get("profiles", []),
                settings=body.get("settings") or {},
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {"run_id": run_id}

    @app.get("/api/runs")
    def runs():
        return {"runs": manager.list_runs()}

    @app.get("/api/runs/{run_id}")
    def run_detail(run_id: str):
        doc = manager.load_run(run_id)
        if doc is None:
            raise HTTPException(status_code=404, detail=f"no such run: {run_id}")
        return doc

    @app.get("/api/run/{run_id}/status")
    def run_status(run_id: str):
        try:
            return manager.status(run_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.get("/api/health")
    def health():
        return {"ok": True}

    return app


def run_server(manager: RunManager, config_path: Path, port: int = 8585):
    import uvicorn

    app = create_app(manager, config_path)
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")
