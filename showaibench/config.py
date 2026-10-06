"""Parse servers.conf (INI) into ServerConfig objects."""

from __future__ import annotations

import configparser
from dataclasses import dataclass
from pathlib import Path

PROFILES = ["chat", "code-generation", "classification", "fixed-length"]

# llama-benchy-style workload shapes per profile (prompt processing / generation tokens).
PROFILE_PRESETS = {
    "fixed-length": {"pp": 200, "tg": 800},
    "chat": {"pp": 1024, "tg": 800},
    "code-generation": {"pp": 4096, "tg": 50},
    "classification": {"pp": 10000, "tg": 50},
}

# llama-benchy settings exposed in the UI. depths: whitespace-separated context
# depths; concurrency: number of concurrent requests per test.
DEFAULT_SETTINGS = {"runs": 3, "depths": "0", "concurrency": "1"}


@dataclass
class ServerConfig:
    name: str
    url: str  # scheme://host:port, WITHOUT /v1 (the adapter appends it)
    model: str  # model id sent in the request body
    tokenizer_name: str  # HF Hub repo used for token counting
    api_key: str = ""
    extra_body: str = ""  # extra JSON fields merged into benchmark requests

    def as_json(self) -> dict:
        return {
            "name": self.name,
            "url": self.url,
            "model": self.model,
            "tokenizer_name": self.tokenizer_name,
            "has_api_key": bool(self.api_key),
        }


def load_servers(path: str | Path) -> dict[str, ServerConfig]:
    parser = configparser.ConfigParser()
    parser.optionxform = str.lower  # keys are case-insensitive (dashes kept)
    read = parser.read(str(path))
    if not read:
        raise FileNotFoundError(f"servers config not found: {path}")

    servers: dict[str, ServerConfig] = {}
    for section in parser.sections():
        raw = {k.replace("-", "_").lower(): v.strip() for k, v in parser.items(section)}
        name = section.strip()
        url = raw.get("url", "")
        model = raw.get("model", "")
        tokenizer = raw.get("tokenizer_name", "")
        if not url or not model or not tokenizer:
            raise ValueError(
                f"server '{name}' in {path} needs url, model and tokenizer-name"
            )
        servers[name] = ServerConfig(
            name=name,
            url=url,
            model=model,
            tokenizer_name=tokenizer,
            api_key=raw.get("api_key", ""),
            extra_body=raw.get("extra_body", ""),
        )
    return servers
