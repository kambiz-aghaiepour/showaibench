# showaibench

A web visualizer for benchmarking OpenAI-compatible inference servers
(among others [llama.cpp](https://github.com/ggml-org/llama.cpp) and vLLM)
with [llama-benchy](https://github.com/eugr/llama-benchy).

Point it at one or more servers, run its standard workload profiles
(chat, code-generation, classification, fixed-length), and compare the
results of any runs side by side — across servers, runs, context depths,
and concurrency levels.

![Dashboard](docs/screenshots/dashboard.png)

---

## How it works

```
servers.conf ──► main.py (FastAPI, 127.0.0.1:8585)
                    │
                    ├─ per (server × profile): llama-benchy subprocess
                    │     • servers benchmark IN PARALLEL, profiles serially
                    │     • stdout/stderr streamed to results/<run>/<server>__<profile>.log
                    │       (PYTHONUNBUFFERED → live tailing)
                    │     • JSON report parsed into per-shape metric rows
                    │       (pp/tg throughput ± std, TTFR, est. PPT, E2E TTFT, peak)
                    │
                    ├─ live status: /api/run/<id>/status returns per-entry
                    │   state (pending/running/ok/error) + log tail
                    │
                    └─ persistence: results/<run>/run.json + raw reports
                        (survives restarts; list/select old runs)
```

### Components

| File | Role |
|---|---|
| `main.py` | CLI: `--init` (installs llama-benchy into `.venv`), serves the app, `--start-all` headless mode |
| `showaibench/config.py` | Workload profiles, default settings, `load_servers()` (servers.conf parser) |
| `showaibench/benchmarker.py` | llama-benchy adapter: command construction, live-log streaming, HF token env, report → rows |
| `showaibench/runner.py` | `RunManager`: run orchestration, live status, persistence |
| `showaibench/server.py` | FastAPI app + `/api/*` endpoints + static files |
| `showaibench/static/` | Frontend (plain JS + Plotly, no build step) |
| `manage-webapp` | start / stop / verify the web app (pidfile + health + config drift check) |
| `servers.conf.example` | Template for `servers.conf` |

### Frontend behavior

- **Runs & Profiles** dropdowns (multi-select with checkmarks); new runs
  started anywhere appear within seconds of the page being open.
- **Live panel**: while a job runs, one `tail -f`-style pane per active
  `llama-benchy` process (i.e. per server), refreshed every 3 s. Reloading
  the page mid-run keeps the live panel (a watcher attaches on load) and
  the page **auto-reloads when the job completes**.
- **Chart controls** (right panel): enable/disable graphs (metrics), hosts,
  and element categories (`profile (xN)`); each group has a
  Select All / Unselect All toggle. Nothing is selected by default —
  select what you want to compare.
- **Grouped bar charts**: one metric per card, full width. Bars are ordered
  group-major (all `chat (x1)` cells, then `code-generation (x1)`, …), with
  a legend block (header + color chips) aligned above each group; x labels
  show context depth. Error bars show run-to-run std.
- **Failure handling**: a run that ends with any failed entry shows a
  collapsed failure strip with the full tool log — and no partial graphs.
- **Theme** toggle (dark/light).

### Workload profiles

| Profile | Prompt | Completion | What it measures |
|---|---|---|---|
| `fixed-length` | 200 | 800 | mostly decode speed |
| `chat` | 1024 | 800 | typical conversational turn |
| `code-generation` | 4096 | 50 | prefill-heavy |
| `classification` | 10000 | 50 | long-context ingestion |

**Settings** (dropdowns): Runs 1–10 (default 3), Concurrency 1–16 (default 1),
Depths presets `0` … `0 4096 8192 16384 32768` (default `0 4096 8192`).
The estimate box predicts wall time from ~1000/80 t/s assumptions — use it
as a rough guide only.

### The screenshots

This run compares two servers both serving the same Qwen model:
`llama-cpp` (RTX 3090 Ti, Q4_K_M + MTP spec-decode) vs `dgx` (GB10,
full precision). The charts show generation being bandwidth-bound (llama ~8
tokens/s vs dgx ~70 t/s — quantized weights + speculative decoding), while
prefill favors the DGX.

![Chart controls](docs/screenshots/chart-controls.png)

The right panel filters: Graphs (which metric cards render), Hosts (which
servers' bars), Elements (which `profile (xN)` categories).

![Grouped legends](docs/screenshots/grouped-legends.png)

Each test category has its own legend block aligned above its bars; chips
match bar colors (`dgx/074620`, `llama-cpp/074620`).

---

## Getting started

Requirements: Python 3.11+, an OpenAI-compatible inference server.
`llama-benchy` is installed automatically by `--init`.

```bash
git clone git@github.com:<your-user>/showaibench.git
cd showaibench
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
python3 main.py --init            # installs llama-benchy (pip, fallback: git)
cp servers.conf.example servers.conf   # edit: url/model/tokenizer-name
python3 main.py                   # http://127.0.0.1:8585
```

Or manage it as a small daemon:

```bash
./manage-webapp --start     # nohup + health wait (log: webapp.log)
./manage-webapp --verify    # up? config in sync with servers.conf?
./manage-webapp --stop      # stop (warns if a benchmark is running)
```

`--init` will use a Hugging Face token from `~/Documents/huggingface`
if present (for tokenizer downloads); it is never logged or committed.

## Configuration

`servers.conf` — one section per server:

```ini
[dgx]
url = http://192.168.1.10:8000        ; /v1 is appended automatically
model = org/model-name                ; id served by /v1/models
tokenizer-name = org/model-name       ; HF repo for token counting
api-key =                             ; optional Bearer token
extra-body = chat_template_kwargs={"enable_thinking":false}
```

Changes require an app restart (config is read at startup). The app binds to
`127.0.0.1` only and stores nothing sensitive; results live under `results/`.

## Credits

- [llama-benchy](https://github.com/eugr/llama-benchy) — the benchmark engine
  (OpenAI-compatible benchmarker; also on PyPI). showaibench is a thin
  orchestrator/visualizer around it.
- [Plotly.js](https://plotly.com/javascript/) — charts (vendored in `static/`).
- FastAPI + uvicorn — HTTP layer.
