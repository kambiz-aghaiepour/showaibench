"""Publish benchmark reports as GitHub gists (gh CLI + git).

`gh gist create` only accepts text files, so images are pushed through the
gist's underlying git repo (see docs/gist-howto): create the gist with the
markdown, clone it, add the PNGs, rewrite the image tokens in the markdown to
absolute raw URLs, commit and push.
"""

from __future__ import annotations

import base64
import json
import os
import shutil
import subprocess
import tempfile
import threading
from datetime import datetime
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parent.parent
REGISTRY_PATH = APP_ROOT / "gists.json"

_lock = threading.Lock()

# gh's credential helper, passed per-git-call so the user's global git config
# is never touched; GIT_TERMINAL_PROMPT=0 avoids interactive auth hangs.
GIT = ["-c", "credential.helper=!gh auth git-credential"]
_ENV = {**os.environ, "GIT_TERMINAL_PROMPT": "0"}


def _run(args: list[str], timeout: int = 60, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(
        args, capture_output=True, text=True, timeout=timeout, check=check, env=_ENV
    )


def gh_status() -> dict:
    """Whether the gh CLI exists and the webapp user is authenticated."""
    if shutil.which("gh") is None:
        return {"available": False, "authenticated": False, "user": None}
    try:
        _run(["gh", "auth", "status"], timeout=30, check=False)
    except Exception:
        return {"available": True, "authenticated": False, "user": None}
    user = None
    try:
        user = (_run(["gh", "api", "user", "--jq", ".login"], timeout=30).stdout or "").strip() or None
    except Exception:
        pass
    return {"available": True, "authenticated": True, "user": user}


def load_registry() -> list[dict]:
    if not REGISTRY_PATH.exists():
        return []
    try:
        entries = json.loads(REGISTRY_PATH.read_text())
        return entries if isinstance(entries, list) else []
    except (ValueError, OSError):
        return []


def _save_registry(entries: list[dict]) -> None:
    REGISTRY_PATH.write_text(json.dumps(entries, indent=2))


def record(entry: dict) -> None:
    with _lock:
        entries = load_registry()
        entries = [e for e in entries if e.get("id") != entry["id"]]
        entries.insert(0, entry)
        _save_registry(entries)


def create_gist(filename: str, description: str, markdown: str, images: dict[str, bytes]) -> dict:
    """Create a secret gist, push images + final markdown, return its record."""
    if not filename or not markdown:
        raise ValueError("missing gist filename or markdown")
    if sum(len(b) for b in images.values()) > 25 * 1024 * 1024:
        raise ValueError("images too large (max 25 MB)")
    tmp = Path(tempfile.mkdtemp(prefix="showgist-"))
    try:
        md_file = tmp / filename
        md_file.write_text(markdown, encoding="utf-8")
        proc = _run(["gh", "gist", "create", str(md_file), "-d", description or "show-aibench benchmark report"], timeout=120)
        url = next(
            (line.strip() for line in proc.stdout.splitlines() if line.strip().startswith("https://gist.github.com/")),
            "",
        )
        if not url:
            raise RuntimeError(f"could not parse gist URL from gh output:\n{proc.stdout}\n{proc.stderr}")
        gist_id = url.rstrip("/").rsplit("/", 1)[-1]
        user = url.split("gist.github.com/")[1].split("/")[0]
        raw_url = f"https://gist.githubusercontent.com/{user}/{gist_id}/raw"

        repo = tmp / "repo"
        _run(["git", *GIT, "clone", f"https://gist.github.com/{gist_id}.git", str(repo)], timeout=120)
        for name, data in images.items():
            (repo / name).write_bytes(data)
        for name in images:
            markdown = markdown.replace(f"[[IMG:{name}]]", f"{raw_url}/{name}")
        (repo / filename).write_text(markdown, encoding="utf-8")
        _run(["git", "-C", str(repo), *GIT, "add", "-A"], timeout=60)
        _run([
            "git", "-C", str(repo), *GIT,
            "-c", "user.name=show-aibench", "-c", "user.email=show-aibench@users.noreply.github.com",
            "commit", "-m", "add benchmark chart images", "--quiet",
        ], timeout=60)
        _run(["git", "-C", str(repo), *GIT, "push"], timeout=120)

        return {
            "id": gist_id,
            "url": url,
            "markdown_url": f"{raw_url}/{filename}",
            "filename": filename,
            "description": description,
            "created_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        }
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def list_valid() -> list[dict]:
    """Registry entries whose gist still exists on GitHub."""
    valid = []
    for entry in load_registry():
        try:
            _run(["gh", "api", f"gists/{entry['id']}", "--jq", ".id"], timeout=30)
            valid.append(entry)
        except Exception:
            continue  # purged / gone: hide it
    return valid


def delete_gist(gist_id: str) -> None:
    """Delete the gist on GitHub and drop it from the registry."""
    _run(["gh", "gist", "delete", gist_id, "--yes"], timeout=60)
    with _lock:
        entries = [e for e in load_registry() if e.get("id") != gist_id]
        _save_registry(entries)


def decode_image(name: str, data: str) -> bytes:
    """Validate and base64-decode one uploaded PNG."""
    if not name or not data:
        raise ValueError("image name/data missing")
    try:
        raw = base64.b64decode(data, validate=True)
    except Exception as exc:
        raise ValueError(f"image {name}: not valid base64") from exc
    if raw[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError(f"image {name}: not a PNG")
    return raw
