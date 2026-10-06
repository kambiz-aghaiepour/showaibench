/* show-ai-bench-results - client logic (no build step, plain JS). */

const METRICS = [
  { key: "pp_tps", title: "Prompt Processing (t/s)", field: "pp_tps", err: "pp_tps_std" },
  { key: "tg_tps", title: "Token Generation (t/s)", field: "tg_tps", err: "tg_tps_std" },
  { key: "peak_tps", title: "Peak Generation (t/s)", field: "peak_tps", err: "peak_tps_std" },
  { key: "ttfr", title: "Time to First Response (ms)", field: "ttfr_ms", err: "ttfr_ms_std" },
  { key: "est_ppt", title: "Est. Prompt Processing Time (ms)", field: "est_ppt_ms", err: "est_ppt_ms_std" },
  { key: "e2e_ttft", title: "End-to-End TTFT (ms)", field: "e2e_ttft_ms", err: "e2e_ttft_ms_std" },
];

const PALETTE = [
  "#4da3ff", "#f0a500", "#3fb950", "#e35d8f", "#9d7bf7",
  "#2ec4b6", "#f85149", "#b6c454", "#7aa2f7", "#e8b9f0",
];

const state = {
  servers: [],
  profiles: [],
  runs: [],
  runDocs: {},          // runId -> doc (cache)
  selectedRuns: new Set(),
  selectedProfiles: new Set(),
  runsKey: "",            // cached run-id list key for change detection
  liveStatus: {},       // runId -> status doc while running
  watchTimer: null,
  sawRunning: false,
  metricsOn: new Set(), // metric keys shown
  hostsOn: new Set(),   // server names included in charts
  elementsOn: new Set(), // "server|profile|runId" traces shown
};

const $ = (sel) => document.querySelector(sel);
const el = (tag, attrs = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const child of children) node.append(child);
  return node;
};

/* ------------------------------------------------------------- theme */

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("sar-theme", theme);
  renderCharts();
}
function initTheme() {
  const saved = localStorage.getItem("sar-theme");
  document.documentElement.dataset.theme = saved || "dark";
  $("#theme-toggle").onclick = () =>
    applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
}

/* ------------------------------------------------------------- api */

async function api(path, opts) {
  const resp = await fetch(path, opts);
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    throw new Error(body.detail || `${resp.status} ${resp.statusText}`);
  }
  return resp.json();
}

/* ------------------------------------------------------------- controls */

let updateServAll = () => {};
let updateProfAll = () => {};

function makeChoiceToggle(containerSel, btnSel, onToggle) {
  const btn = $(btnSel);
  const update = () => {
    const items = [...$(containerSel).querySelectorAll("input")];
    const allOn = items.length > 0 && items.every((i) => i.checked);
    btn.textContent = allOn ? "Unselect All" : "Select All";
    btn.disabled = items.length === 0;
  };
  btn.onclick = () => {
    const items = [...$(containerSel).querySelectorAll("input")];
    const allOn = items.length > 0 && items.every((i) => i.checked);
    for (const i of items) i.checked = !allOn;
    onToggle();
    update();
  };
  return update;
}

function renderChoices() {
  const serversBox = $("#servers");
  serversBox.replaceChildren();
  for (const s of state.servers) {
    serversBox.append(el("label", {}, [
      el("input", { type: "checkbox", value: s.name }),
      el("span", { text: `${s.name} (${s.model})` }),
    ]));
  }
  const profBox = $("#profiles");
  profBox.replaceChildren();
  for (const p of state.profiles) {
    profBox.append(el("label", {}, [el("input", { type: "checkbox", value: p }), el("span", { text: p })]));
  }
  updateServAll = makeChoiceToggle("#servers", "#servers-all", updateStartEnabled);
  updateProfAll = makeChoiceToggle("#profiles", "#profiles-all", updateStartEnabled);
  updateServAll();
  updateProfAll();
  updateStartEnabled();
}

function selectedValues(box) {
  return [...box.querySelectorAll("input:checked")].map((i) => i.value);
}

function updateStartEnabled() {
  $("#start-btn").disabled =
    selectedValues($("#servers")).length === 0 || selectedValues($("#profiles")).length === 0;
  updateTimeEstimate();
}

function readSettings() {
  const n = (id, fallback) => {
    const v = parseInt($(id).value, 10);
    return Number.isFinite(v) ? v : fallback;
  };
  return {
    runs: n("#set-runs", 3),
    depths: $("#set-depths").value.trim() || "0",
    concurrency: n("#set-concurrency", 1),
  };
}

/* Estimate: per profile, time ~ depth_count x (runs + warmup_runs) x
   (pp tokens / ~1000 t/s + tg tokens / ~80 t/s + 2 s overhead), profiles
   serial per server, servers in parallel. */
function updateTimeEstimate() {
  const s = readSettings();
  const depths = s.depths.split(/[\s,]+/).filter(Boolean);
  const depthCount = Math.max(1, depths.length);
  const profCount = Math.max(1, selectedValues($("#profiles")).length);
  const serverCount = Math.max(1, selectedValues($("#servers")).length);
  let totalS = 0;
  for (const prof of selectedValues($("#profiles"))) {
    const preset = PROFILE_PRESETS[prof];
    if (!preset) continue;
    const runS = preset.pp / 1000 + preset.tg / 80 + 2;
    totalS += depthCount * s.runs * runS;
  }
  const perServerMin = totalS / 60;
  const mode = serverCount > 1
    ? `${serverCount} servers run IN PARALLEL; total = per-server time (profiles sequential per server)`
    : "1 server; profiles run one after another";
  $("#time-est").textContent =
    `${Math.round((perServerMin / Math.max(1, profCount)) * 10) / 10} min per server×profile · ` +
    `~${Math.ceil(perServerMin)} min total · ${mode}`;
}

const PROFILE_PRESETS = {
  "fixed-length": { pp: 200, tg: 800 },
  "chat": { pp: 1024, tg: 800 },
  "code-generation": { pp: 4096, tg: 50 },
  "classification": { pp: 10000, tg: 50 },
};

async function startRun() {
  if ($("#start-btn").disabled) return;
  const body = {
    servers: selectedValues($("#servers")),
    profiles: selectedValues($("#profiles")),
    settings: readSettings(),
  };
  $("#run-status").textContent = "starting...";
  try {
    const { run_id } = await api("/api/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    $("#start-btn").disabled = true;
    $("#run-status").textContent = `running: ${run_id} — live log below`;
    startWatching();
  } catch (err) {
    $("#run-status").textContent = `error: ${err.message}`;
  }
}

/* Live watcher: polls every 3s while any run is running; renders live
   status + log tail; reloads the page once everything finishes so the
   final charts / failure banner render from fresh state. */
function startWatching() {
  if (state.watchTimer) return;
  let reloaded = false;
  const tick = async () => {
    let runs;
    try {
      runs = (await api("/api/runs")).runs;
    } catch {
      return;
    }
    if (syncRunsList(runs)) {
      try {
        await refreshViewer();
      } catch { /* transient */ }
    }
    const running = runs.filter((r) => r.status === "running");
    if (running.length) {
      state.sawRunning = true;
      for (const r of running) {
        try {
          state.liveStatus[r.id] = await api(`/api/run/${r.id}/status`);
        } catch { /* transient; retry next tick */ }
      }
      renderLive();
      return;
    }
    if (state.sawRunning && !reloaded) {
      reloaded = true;
      clearInterval(state.watchTimer);
      state.watchTimer = null;
      location.reload();
    }
  };
  state.watchTimer = setInterval(tick, 3000);
  tick();
}

function renderLive() {
  const host = $("#run-live");
  host.replaceChildren();
  const running = Object.entries(state.liveStatus)
    .filter(([, st]) => st && st.status === "running");
  if (!running.length) return;
  for (const [id, st] of running) {
    const box = el("div", { class: "live-strip" });
    box.append(el("h4", { text: `Running ${id} (started ${st.started_at})` }));
    const grid = el("div", { class: "live-rows" });
    for (const row of st.rows) {
      const label = row.status === "ok" ? "done" : row.status;
      grid.append(el("div", { class: "row" }, [
        el("span", { class: `dot ${row.status}` }),
        el("span", { text: `${row.server} / ${row.profile} — ${label}` }),
      ]));
    }
    box.append(grid);
    // one tail -f pane per active benchy process (a server with a running entry)
    for (const row of st.rows) {
      if (row.status !== "running" || !row.log_tail) continue;
      box.append(el("div", { class: "live-entry" }, [
        el("span", { class: "live-entry-label", text: `${row.server} / ${row.profile} — live output` }),
        el("pre", { class: "log", text: row.log_tail }),
      ]));
    }
    host.append(box);
  }
  for (const pre of host.querySelectorAll("pre.log")) {
    pre.scrollTop = pre.scrollHeight;
  }
}

/* -------------------------------------------------- multi-select dropdowns */

function makeMultiSelect(btnSel, panelSel, labelPrefix, onApply) {
  const btn = $(btnSel);
  const panel = $(panelSel);
  let selectedSet = new Set();
  const update = () => {
    btn.textContent = `${labelPrefix}: ${selectedSet.size} selected ▾`;
  };
  btn.onclick = (e) => { e.stopPropagation(); panel.classList.toggle("hidden"); };
  panel.onclick = (e) => e.stopPropagation();
  document.addEventListener("click", () => panel.classList.add("hidden"));

  return {
    render(items, selected, getLabel) {
      selectedSet = selected;
      panel.replaceChildren();
      for (const item of items) {
        const inp = el("input", { type: "checkbox", value: item });
        inp.checked = selectedSet.has(item);
        inp.addEventListener("change", () => {
          if (inp.checked) selectedSet.add(item); else selectedSet.delete(item);
          update();
          onApply();
        });
        panel.append(el("label", {}, [inp, el("span", { text: getLabel(item) })]));
      }
      update();
    },
    update,
  };
}

/* ------------------------------------------------------------- runs */

function syncRunsList(runs) {
  const key = runs.map((r) => r.id).join(",");
  if (key === state.runsKey) return false;
  state.runsKey = key;
  state.runs = runs;
  const valid = new Set(runs.map((r) => r.id));
  for (const id of [...state.selectedRuns]) if (!valid.has(id)) state.selectedRuns.delete(id);
  runsMS.render(
    runs.map((r) => r.id),
    state.selectedRuns,
    (id) => {
      const r = runs.find((x) => x.id === id);
      const hosts = (r?.servers || []).join(", ");
      return `${id} — ${state.runDocs[id]?.status || r?.status || "?"}${hosts ? ` [${hosts}]` : ""}`;
    },
  );
  return true;
}

async function refreshRuns(selectLatest = false) {
  const { runs } = await api("/api/runs");
  if (selectLatest && runs.length) {
    state.selectedRuns.clear();
    state.selectedRuns.add(runs[0].id);
  }
  syncRunsList(runs);
  await refreshViewer();
}

async function refreshViewer() {
  await Promise.all(
    [...state.selectedRuns].map(async (id) => {
      if (!state.runDocs[id]) state.runDocs[id] = await api(`/api/runs/${id}`);
    }),
  );

  const profiles = [...new Set(
    [...state.selectedRuns].flatMap((id) => state.runDocs[id]?.profiles || []),
  )];
  const validProfiles = new Set(profiles);
  for (const p of [...state.selectedProfiles]) if (!validProfiles.has(p)) state.selectedProfiles.delete(p);
  if (!state.selectedProfiles.size && profiles.length) {
    for (const p of profiles) state.selectedProfiles.add(p);
  }
  profsMS.render(profiles, state.selectedProfiles, (p) => p);

  renderCharts();
  renderErrors();
  renderControls();
}

/* ------------------------------------------------ chart visibility controls */

function ctlCheckboxes(container, allBtn, items, selected, labelFn, onToggle) {
  container.replaceChildren();
  for (const it of items) {
    const inp = el("input", { type: "checkbox" });
    inp.checked = selected.has(it);
    inp.addEventListener("change", () => {
      if (inp.checked) selected.add(it); else selected.delete(it);
      onToggle();
    });
    container.append(el("label", {}, [inp, el("span", { text: labelFn(it) })]));
  }
  const allOn = items.length > 0 && items.every((it) => selected.has(it));
  allBtn.textContent = allOn ? "Unselect All" : "Select All";
  allBtn.disabled = items.length === 0;
  allBtn.onclick = () => {
    if (allOn) for (const it of items) selected.delete(it);
    else for (const it of items) selected.add(it);
    onToggle();
  };
}

/* Right-hand panel: graphs / hosts / elements. Nothing is selected by
   default; each category has a Select All / Unselect All toggle.
   Elements are grouped per test category (profile x concurrency):
   a checkbox enables that test across all matching hosts/datasets. */
function renderControls() {
  const hosts = [];
  const elements = []; // "profile|concurrency" categories
  for (const runId of [...state.selectedRuns]) {
    const doc = state.runDocs[runId];
    if (!doc) continue;
    const results = doc.results || {};
    for (const profile of [...state.selectedProfiles]) {
      for (const sname of Object.keys(results)) {
        const entry = results[sname]?.[profile];
        if (!entry || entry.status !== "ok") continue;
        const rows = entry.rows || [];
        if (!rows.length) continue;
        if (!hosts.includes(sname)) hosts.push(sname);
        const cat = `${profile}|${rows[0].concurrency}`;
        if (!elements.includes(cat)) elements.push(cat);
      }
    }
  }
  // drop selections that no longer belong to the selected datasets
  for (const h of [...state.hostsOn]) if (!hosts.includes(h)) state.hostsOn.delete(h);
  for (const e of [...state.elementsOn]) if (!elements.includes(e)) state.elementsOn.delete(e);

  const refresh = () => { renderCharts(); renderControls(); };
  ctlCheckboxes(
    $("#ctl-metrics"), $("#ctl-metrics-all"), METRICS.map((m) => m.key), state.metricsOn,
    (k) => METRICS.find((m) => m.key === k).title, refresh,
  );
  ctlCheckboxes($("#ctl-hosts"), $("#ctl-hosts-all"), hosts, state.hostsOn, (s) => s, refresh);
  ctlCheckboxes($("#ctl-elements"), $("#ctl-elements-all"), elements, state.elementsOn, (key) => {
    const [profile, conc] = key.split("|");
    return `${profile} (x${conc})`;
  }, refresh);
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function renderCharts() {
  const container = $("#charts");
  container.replaceChildren();
  const runIds = [...state.selectedRuns];
  const profs = [...state.selectedProfiles];
  const meta = [];
  for (const id of runIds) {
    const doc = state.runDocs[id];
    if (!doc) continue;
    const s = doc.settings || {};
    meta.push(`${id} [${doc.status}, runs=${s.runs} depth=${(s.depths || []).join(",")} conc=${s.concurrency}]`);
  }
  $("#run-meta").textContent = meta.join(" · ");

  if (!runIds.length || !profs.length) {
    container.append(el("div", { class: "empty", text: "No runs selected. Start a benchmark to see results." }));
    return;
  }

  const metrics = METRICS.filter((m) => state.metricsOn.has(m.key));
  if (!metrics.length) {
    container.append(el("div", { class: "empty", text: "No graphs selected — tick graphs in the Chart controls on the right." }));
    return;
  }

  for (const metric of metrics) {
    const card = el("div", { class: "card" });
    card.append(el("h3", { text: metric.title }));
    container.append(card);

    const groups = []; // {key, label, depths: [], entries: [{label,color}], traces: []}
    const gidx = new Map();
    let colorIdx = 0;
    let yMin = Infinity;
    let yMax = -Infinity;
    for (const runId of runIds) {
      const doc = state.runDocs[runId];
      if (!doc || doc.status !== "done") continue; // failed runs: banner, no partial graphs
      for (const profile of profs) {
        for (const [sname] of Object.entries(doc.servers || {})) {
          if (!state.hostsOn.has(sname)) continue;
          const entry = doc.results?.[sname]?.[profile];
          if (!entry || entry.status !== "ok") continue; // shown in the error strip
          const rows = entry.rows || [];
          if (!rows.length) continue;
          const conc = rows[0].concurrency;
          if (!state.elementsOn.has(`${profile}|${conc}`)) continue;
          const gkey = `${profile}|${conc}`;
          let g = gidx.get(gkey);
          if (!g) {
            g = { key: gkey, label: `${profile} (x${conc})`, depths: [], entries: [], traces: [] };
            gidx.set(gkey, g);
            groups.push(g);
          }
          for (const r of rows) if (!g.depths.includes(r.depth)) g.depths.push(r.depth);
          const byDepth = new Map(rows.map((r) => [r.depth, r]));
          const yvals = g.depths.map((d) => byDepth.get(d)?.[metric.field] ?? null);
          for (const v of yvals) {
            if (v == null) continue;
            yMin = Math.min(yMin, v);
            yMax = Math.max(yMax, v);
          }
          const color = PALETTE[colorIdx % PALETTE.length];
          colorIdx++;
          g.traces.push({
            x: g.depths.map((d) => `${g.key}|${d}`),
            y: yvals,
            type: "bar",
            name: `${sname} / ${profile} (x${conc}) / ${runId}`,
            marker: { color },
          });
          const model = doc.servers?.[sname]?.model || "?";
          g.entries.push({ label: `${sname}/${model}/${runId.slice(-6)}`, color });
        }
      }
    }

    if (!groups.length || groups.every((g) => !g.traces.length)) {
      card.append(el("div", { class: "empty", text: "No data for this selection." }));
      continue;
    }

    // one chart per test group (hosts x runs traces only) so bar thickness
    // never depends on how many element types are selected; shared y range
    // keeps the groups visually comparable
    if (yMax === -Infinity) { yMin = 0; yMax = 1; }
    const pad = (yMax - yMin) * 0.08 || 1;
    const yrange = [yMin - pad, yMax + pad];
    const row = el("div", { class: "subplot-row" });
    card.append(row);
    const pending = [];
    for (const g of groups) {
      const sub = el("div", { class: "subplot" });
      sub.append(el("div", { class: "lg-head", text: g.label }));
      const chips = el("div", { class: "lg-chips" });
      for (const e of g.entries) {
        chips.append(el("span", { class: "lg-chip" }, [
          el("i", { style: `background:${e.color}` }),
          el("span", { text: e.label }),
        ]));
      }
      sub.append(chips);
      const slot = el("div", { class: "plot-slot" });
      sub.append(slot);
      row.append(sub);
      pending.push({ slot, g });
    }
    // create the charts only after every slot exists, so each one measures
    // its final flex width (creating them inline left earlier slots at the
    // transient full-row width, which then never resized)
    for (const { slot, g } of pending) {
      Plotly.newPlot(slot, g.traces, {
        margin: { l: 44, r: 8, t: 4, b: 36 },
        showlegend: false,
        font: { size: 11, color: cssVar("--text") },
        paper_bgcolor: cssVar("--panel"),
        plot_bgcolor: cssVar("--panel"),
        barmode: "group",
        xaxis: {
          type: "category",
          tickangle: 90,
          tickvals: g.depths.map((d) => `${g.key}|${d}`),
          ticktext: g.depths.map((d) => `d${d}`),
          gridcolor: cssVar("--border"),
          zeroline: false,
        },
        yaxis: { range: yrange, gridcolor: cssVar("--border"), zeroline: false },
      }, { responsive: true, displayModeBar: false });
    }
  }
}

/* One collapsible strip for failed benchmarks instead of the error text
   being repeated under every chart. */
function renderErrors() {
  const strip = $("#run-errors");
  strip.replaceChildren();
  const items = [];
  for (const runId of [...state.selectedRuns]) {
    const doc = state.runDocs[runId];
    if (!doc || doc.status !== "error") continue; // running runs appear in the live panel
    for (const profile of [...state.selectedProfiles]) {
      for (const sname of Object.keys(doc.servers || {})) {
        const entry = doc.results?.[sname]?.[profile];
        if (!entry || entry.status === "ok") continue;
        items.push({
          label: `${sname} / ${profile} / ${runId}`,
          error: entry.error || entry.status,
        });
      }
    }
  }
  if (!items.length) return;
  const head = el("div", { class: "error-strip" });
  head.append(el("h4", { text: `Failed benchmarks (${items.length})` }));
  for (const it of items) {
    const summary = it.error.split("\n")[0].slice(0, 160);
    const det = el("details", {}, [
      el("summary", { text: `⚠ ${it.label}: ${summary}` }),
      el("pre", { text: it.error }),
    ]);
    head.append(det);
  }
  strip.append(head);
}

/* ------------------------------------------------------------- init */

const runsMS = makeMultiSelect("#runs-ms-btn", "#runs-ms-panel", "Runs", refreshViewer);
const profsMS = makeMultiSelect("#profs-ms-btn", "#profs-ms-panel", "Profiles", renderCharts);

async function main() {
  initTheme();
  const [servers, profiles] = await Promise.all([api("/api/servers"), api("/api/profiles")]);
  state.servers = servers.servers;
  state.profiles = profiles.profiles;
  renderChoices();
  $("#start-btn").onclick = startRun;
  $("#servers").addEventListener("change", () => { updateStartEnabled(); updateServAll(); });
  $("#profiles").addEventListener("change", () => { updateStartEnabled(); updateProfAll(); });
  for (const id of ["#set-runs", "#set-depths", "#set-concurrency"]) {
    $(id).addEventListener("input", updateTimeEstimate);
  }
  updateTimeEstimate();
  await refreshRuns();
  startWatching();
}

main().catch((err) => {
  document.body.append(el("div", { class: "empty", text: `load error: ${err.message}` }));
});
