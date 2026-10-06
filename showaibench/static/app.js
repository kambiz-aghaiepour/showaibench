/* show-ai-bench-results - client logic (no build step, plain JS). */

const METRICS = [
  { key: "pp_tps", title: "Prompt Processing (t/s)", field: "pp_tps", err: "pp_tps_std" },
  { key: "tg_tps", title: "Token Generation (t/s)", field: "tg_tps", err: "tg_tps_std" },
  { key: "peak_tps", title: "Peak Generation (t/s)", field: "peak_tps", err: "peak_tps_std" },
  { key: "ttfr", title: "Time to First Response (ms)", field: "ttfr_ms", err: "ttfr_ms_std" },
  { key: "est_ppt", title: "Est. Prompt Processing Time (ms)", field: "est_ppt_ms", err: "est_ppt_ms_std" },
  { key: "e2e_ttft", title: "End-to-End TTFT (ms)", field: "e2e_ttft_ms", err: "e2e_ttft_ms_std" },
];

/* Multi-line hover tooltip: per-bar identity + the measured value. The
   array indexes reference each trace's customdata (see renderCharts). */
const TOOLTIP_TEMPLATE =
  "<b>%{customdata[0]} / %{customdata[2]} (x%{customdata[3]}) / %{customdata[7]}</b><br>" +
  "<b>Server:</b> %{customdata[0]}<br>" +
  "<b>Model:</b> %{customdata[1]}<br>" +
  "<b>Concurrency:</b> %{customdata[3]}<br>" +
  "<b>Depth:</b> %{customdata[4]}<br>" +
  "<b>Date:</b> %{customdata[5]}<br>" +
  "<b>Time:</b> %{customdata[6]}<br>" +
  "<b>Profile:</b> %{customdata[2]}<br>" +
  "<b>Run:</b> %{customdata[7]}<br>" +
  "<b>Prompt/Completion:</b> %{customdata[8]} / %{customdata[9]}<br>" +
  "<b>%{customdata[10]}:</b> %{y:.2f}<br>%{customdata[11]}";

/* Deterministic trace colors with guaranteed variance: consecutive traces
   (the adjacent bars inside a merged depth cell) are separated by the golden
   angle in hue, so bars of the same profile/host at different concurrencies
   never receive similar colors, no matter how many are selected. The offset
   starts near the classic blue and keeps the dark theme look. */
function traceColor(i) {
  const h = (213.5 + i * 137.508) % 360;
  return `hsl(${h.toFixed(1)}, 72%, 60%)`;
}

/* Hue distance in degrees between two hsl() color strings. */
function hueGap(a, b) {
  const hue = (s) => parseFloat(/hsl\(([\d.]+)/.exec(s)[1]);
  const d = Math.abs(hue(a) - hue(b));
  return Math.min(d, 360 - d);
}

/* Minimum hue separation between any two traces grouped in one chart. */
const MIN_HUE_GAP = 45;

/* ------------------------------------------------------- 3D bar shading */

/* Pseudo-3D bevel for flat bars: after every Plotly draw, replace the solid
   fill of each bar with a per-trace vertical gradient (light top edge ->
   base -> darker shadow). Pure SVG defs + path fill override; hover, legends,
   tooltips and the grouped layout are untouched. */
let barGid = 0;

function shadeColor(hsl, dl) { // hsl string -> lighter/darker hsl string
  const m = /hsl\(([\d.]+),\s*([\d.]+)%,\s*([\d.]+)%\)/.exec(hsl);
  if (!m) return hsl;
  const l = Math.max(12, Math.min(92, parseFloat(m[3]) + dl));
  return `hsl(${m[1]}, ${m[2]}%, ${l}%)`;
}

function applyBarShading(slot) {
  if (!state.bar3d) return;
  const svg = slot.querySelector("svg.main-svg");
  if (!svg) return;
  let defs = svg.querySelector("defs.bar3d");
  if (!defs) {
    defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
    defs.setAttribute("class", "bar3d");
    svg.prepend(defs);
  }
  defs.replaceChildren();
  const groups = slot.querySelectorAll(".barlayer .trace");
  groups.forEach((g, i) => {
    const paths = g.querySelectorAll("path");
    if (!paths.length) return;
    const color = slot.data?.[i]?.marker?.color; // hsl() from traceColor()
    if (!color) return;
    const id = `b3d${++barGid}`;
    const grad = document.createElementNS("http://www.w3.org/2000/svg", "linearGradient");
    grad.setAttribute("id", id);
    grad.setAttribute("x1", "0"); grad.setAttribute("y1", "0");
    grad.setAttribute("x2", "0"); grad.setAttribute("y2", "1");
    for (const [off, color2] of [
      [0, shadeColor(color, 22)],
      [0.32, shadeColor(color, 4)],
      [0.62, color],
      [1, shadeColor(color, -18)],
    ]) {
      const stop = document.createElementNS("http://www.w3.org/2000/svg", "stop");
      stop.setAttribute("offset", off);
      stop.style.stopColor = color2; // CSS property: hsl() valid there, but
      grad.append(stop);             // not as an SVG stop-color attribute
    }
    defs.append(grad);
    // one gradient per trace, applied to every bar (every depth) of it
    for (const p of paths) p.style.fill = `url(#${id})`;
  });
}

function unapplyBarShading(slot) {
  const groups = slot.querySelectorAll(".barlayer .trace");
  groups.forEach((g, i) => {
    const color = slot.data?.[i]?.marker?.color;
    if (!color) return;
    for (const p of g.querySelectorAll("path")) p.style.fill = color; // solid
  });
  slot.querySelector("defs.bar3d")?.remove();
}

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
  elementsOn: new Set(), // "profile|concurrency" element categories shown
  combineConc: true,    // merge a profile's concurrencies into one chart
  bar3d: true,          // gradient-shade bars for a beveled 3D look
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
    const head = el("div", { class: "live-head" });
    head.append(el("h4", { text: `Running ${id} (started ${st.started_at})` }));
    head.append(el("button", {
      class: "kill-btn",
      text: "✕ Kill",
      onclick: () => confirmKill(id),
    }));
    box.append(head);
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

/* Modal confirm before killing a running job; OK terminates every live
   benchy process of the run (backend marks entries as killed). */
function confirmKill(runId) {
  const overlay = el("div", { class: "modal-overlay" });
  const modal = el("div", { class: "modal" });
  modal.append(el("h3", { text: "Kill benchmark run?" }));
  modal.append(el("p", {
    text: `Run ${runId} is still running. Killing it terminates the benchmark processes; its partial results will be marked as failed.`,
  }));
  const actions = el("div", { class: "modal-actions" });
  const cancel = el("button", { class: "btn", text: "Cancel" });
  const ok = el("button", { class: "btn danger", text: "OK" });
  const close = (remove = true) => {
    if (remove) overlay.remove();
    document.removeEventListener("keydown", esc);
  };
  const esc = (e) => { if (e.key === "Escape") close(); };
  cancel.onclick = () => close();
  ok.onclick = async () => {
    ok.disabled = true;
    ok.textContent = "Killing…";
    try {
      const res = await api(`/api/run/${runId}/kill`, { method: "POST" });
      close();
    } catch (err) {
      ok.disabled = false;
      ok.textContent = "OK";
      modal.append(el("p", { class: "modal-error", text: `kill failed: ${err.message}` }));
    }
  };
  actions.append(cancel, ok);
  modal.append(actions);
  overlay.append(modal);
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  document.addEventListener("keydown", esc);
  document.body.append(overlay);
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

function runsLabel(id) {
  const r = state.runs.find((x) => x.id === id);
  const doc = state.runDocs[id];
  const servers = r?.servers || [];
  const parts = servers.map((s) => {
    const name = typeof s === "string" ? s : s.name;
    const model = (typeof s === "object" && s.model) || doc?.servers?.[name]?.model;
    return model ? `${name}/${model}` : name;
  });
  return `${id} — ${doc?.status || r?.status || "?"}${parts.length ? ` [${parts.join(", ")}]` : ""}`;
}

function syncRunsList(runs) {
  const key = runs.map((r) => r.id).join(",");
  if (key === state.runsKey) return false;
  state.runsKey = key;
  state.runs = runs;
  const valid = new Set(runs.map((r) => r.id));
  for (const id of [...state.selectedRuns]) if (!valid.has(id)) state.selectedRuns.delete(id);
  runsMS.render(runs.map((r) => r.id), state.selectedRuns, runsLabel);
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
  // re-render run labels now that models resolve from the fetched docs
  runsMS.render(state.runs.map((r) => r.id), state.selectedRuns, runsLabel);

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

function ctlCheckboxes(container, allBtn, items, selected, labelFn, onToggle, opts = {}) {
  // Defaults: a plain one-to-one checkbox list over `selected`. opts may map
  // an item to several keys (e.g. a profile -> its concurrency categories).
  const isOn = opts.isChecked || ((it) => selected.has(it));
  const setOn = opts.setChecked || ((it, on) => { on ? selected.add(it) : selected.delete(it); });
  container.replaceChildren();
  for (const it of items) {
    const inp = el("input", { type: "checkbox" });
    inp.checked = isOn(it);
    inp.addEventListener("change", () => {
      setOn(it, inp.checked);
      onToggle();
    });
    container.append(el("label", {}, [inp, el("span", { text: labelFn(it) })]));
  }
  const allOn = items.length > 0 && items.every((it) => isOn(it));
  allBtn.textContent = allOn ? "Unselect All" : "Select All";
  allBtn.disabled = items.length === 0;
  allBtn.onclick = () => {
    for (const it of items) setOn(it, !allOn);
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
  if (state.combineConc) {
    // One checkbox per profile; selecting it covers every concurrency of
    // that profile present in the selected datasets.
    const profiles = [...new Set(elements.map((e) => e.split("|")[0]))];
    ctlCheckboxes($("#ctl-elements"), $("#ctl-elements-all"), profiles, state.elementsOn,
      (p) => p, refresh, {
        isChecked: (p) => elements.filter((e) => e.startsWith(`${p}|`)).every((e) => state.elementsOn.has(e)),
        setChecked: (p, on) => {
          for (const e of elements) if (e.startsWith(`${p}|`)) {
            if (on) state.elementsOn.add(e); else state.elementsOn.delete(e);
          }
        },
      });
  } else {
    ctlCheckboxes($("#ctl-elements"), $("#ctl-elements-all"), elements, state.elementsOn, (key) => {
      const [profile, conc] = key.split("|");
      return `${profile} (x${conc})`;
    }, refresh);
  }

  const cc = $("#combine-conc");
  cc.classList.toggle("on", state.combineConc);
  cc.setAttribute("aria-checked", state.combineConc ? "true" : "false");
  cc.onclick = () => {
    state.combineConc = !state.combineConc;
    cc.classList.toggle("on", state.combineConc);
    cc.setAttribute("aria-checked", state.combineConc ? "true" : "false");
    renderCharts();
    renderControls();
  };
  const b3d = $("#bar-3d");
  b3d.classList.toggle("on", state.bar3d);
  b3d.setAttribute("aria-checked", state.bar3d ? "true" : "false");
  b3d.onclick = () => {
    state.bar3d = !state.bar3d;
    b3d.classList.toggle("on", state.bar3d);
    b3d.setAttribute("aria-checked", state.bar3d ? "true" : "false");
    // shade in place — no full re-render, so chart width/scrollbars stay put
    for (const slot of document.querySelectorAll("#charts .plot-slot")) {
      if (state.bar3d) applyBarShading(slot); else unapplyBarShading(slot);
    }
  };
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

    const combine = state.combineConc;
    const groups = []; // {key, label, depths: [], entries: [{label,color,profile,conc}], traces: []}
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
          const gkey = combine ? profile : `${profile}|${conc}`;
          let g = gidx.get(gkey);
          if (!g) {
            g = { key: gkey, depths: [], entries: [], traces: [] };
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
          const model = doc.servers?.[sname]?.model || "?";
          const [runDate, runTime] = (doc.started_at || "?").split(" ");
          let color = traceColor(colorIdx++);
          // grouped bars must stay distinguishable: skip any candidate whose
          // hue is too close to a trace already in this chart
          while (g.traces.some((t) => hueGap(t.marker.color, color) < MIN_HUE_GAP)) {
            color = traceColor(colorIdx++);
          }
          const custom = g.depths.map((d) => {
            const r = byDepth.get(d);
            if (!r) return [sname, model, profile, conc, d, runDate, runTime, runId, null, null, metric.title, ""];
            const std = metric.err && r[metric.err] != null ? `± ${r[metric.err].toFixed(2)}` : "";
            return [sname, model, profile, conc, d, runDate, runTime, runId, r.pp ?? null, r.tg ?? null, metric.title, std];
          });
          g.traces.push({
            x: g.depths.map((d) => `${g.key}|${d}`),
            y: yvals,
            type: "bar",
            name: "",
            marker: { color },
            customdata: custom,
            hovertemplate: TOOLTIP_TEMPLATE,
          });
          g.entries.push({ sname, color, profile, conc });
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
      const chips = el("div", { class: "lg-chips" });
      for (const e of g.entries) {
        chips.append(el("span", { class: "lg-chip" }, [
          el("i", { style: `background:${e.color}` }),
          el("span", { class: "lg-lines" }, [
            el("span", { class: "lg-l1", text: `${e.profile} (x${e.conc})` }),
            el("span", { class: "lg-l2", text: e.sname }),
          ]),
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
      const plot = Plotly.newPlot(slot, g.traces, {
        margin: { l: 44, r: 8, t: 4, b: 36 },
        showlegend: false,
        font: { size: 11, color: cssVar("--text") },
        paper_bgcolor: cssVar("--panel"),
        plot_bgcolor: cssVar("--panel"),
        barmode: "group",
        bargroupgap: combine ? 0 : 0.1,
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
      // re-apply the bevel after every Plotly redraw (initial + resizes);
      // the rAF covers the brief window before the first async draw finishes
      slot.on("plotly_afterplot", () => applyBarShading(slot));
      applyBarShading(slot);
      requestAnimationFrame(() => applyBarShading(slot));
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
