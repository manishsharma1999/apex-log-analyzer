// Front-end for the local Apex Log Analyzer. Talks to the Node server's /api/*
// endpoints; the server does the Salesforce and Claude calls.

const state = {
  org: null,
  logs: [],          // org ApexLog metadata records (from Salesforce)
  uploads: [],       // { id, name, body, size, when } for uploaded .log files
  filtered: [],      // normalized items currently shown (after search)
  selectedId: null,  // id of the item open in the viewer
  logBody: "",
  auto: true,
  pollTimer: null,
  loggingReady: false,
  checked: new Set(),      // ids ticked for "analyze selected together"
  query: "",               // the single search box
  contentMatches: null,    // Map(id -> {snippet,count}) for text-in-body hits
  searchSeq: 0,
  analysisAbort: null,     // AbortController for the in-flight Claude request
};
const POLL_MS = 5000;
const MULTI_BUDGET = 150000; // total chars sent for multi-log analysis
let uploadSeq = 0;
let searchTimer = null;

const $ = (id) => document.getElementById(id);
const els = {};
[
  "orgSelect", "refreshBtn", "autoBtn", "uploadBtn", "fileInput", "modelSelect", "statusBar",
  "search", "searchInfo", "logCount", "logRows", "listEmpty", "listPane", "dropHint",
  "selectAll", "bulkBar", "selCount", "analyzeSelected", "clearSelected", "matchInfo",
  "analyzeQuestion", "analyzeBtn", "logView",
  "resizeMain", "resizeAnalysis",
  "analysisPanel", "analysisTitle", "analysisContent", "closeAnalysis",
].forEach((id) => (els[id] = $(id)));

// Cap on how much text we highlight in the viewer. Beyond this we still show
// the whole log (as fast plain text) but skip per-match DOM so huge logs
// (100k+ lines) never freeze the tab.
const MAX_HIGHLIGHT_CHARS = 600000;
const MAX_MARKS = 4000;

// --- helpers --------------------------------------------------------------
function status(msg, kind = "info") {
  els.statusBar.textContent = msg;
  els.statusBar.className = `status ${kind}`;
}
function clearStatus() { els.statusBar.className = "status hidden"; }
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function fmtTime(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleString([], { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
function fmtSize(b) {
  if (b == null) return "";
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1048576).toFixed(1)} MB`;
}
function rescape(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

// --- unified item model (org logs + uploaded files) -----------------------
function orgItem(l) {
  return {
    id: l.Id, kind: "org",
    time: l.StartTime, user: (l.LogUser && l.LogUser.Name) || "",
    operation: l.Operation || "", status: l.Status || "",
    ok: (l.Status || "").toLowerCase() === "success",
    duration: l.DurationMilliseconds, size: l.LogLength,
  };
}
function uploadItem(u) {
  return {
    id: u.id, kind: "upload",
    time: u.when, user: "—", operation: u.name, status: "Uploaded",
    ok: true, duration: null, size: u.size,
  };
}
function allItems() {
  return [...state.uploads.map(uploadItem), ...state.logs.map(orgItem)];
}
function findUpload(id) { return state.uploads.find((u) => u.id === id); }

// --- orgs -----------------------------------------------------------------
async function loadOrgs() {
  try {
    const { orgs } = await api("/api/orgs");
    const prev = els.orgSelect.value;
    els.orgSelect.innerHTML = "";
    if (!orgs.length) {
      const opt = document.createElement("option");
      opt.value = ""; opt.textContent = "No Salesforce session found in Chrome";
      els.orgSelect.appendChild(opt);
      return;
    }
    for (const o of orgs) {
      const opt = document.createElement("option");
      opt.value = o.value;
      opt.textContent = o.profile && o.profile !== "Default" ? `${o.label} · ${o.profile}` : o.label;
      els.orgSelect.appendChild(opt);
    }
    if (prev && orgs.some((o) => o.value === prev)) els.orgSelect.value = prev;
    state.org = els.orgSelect.value;
  } catch (e) {
    status(e.message, "error");
  }
}

// --- log list -------------------------------------------------------------
async function refreshLogs({ silent } = {}) {
  const org = els.orgSelect.value;
  if (!org) { applyFilter(); return; }
  state.org = org;
  try {
    if (!silent) status("Loading logs…", "info");
    const { records } = await api(`/api/logs?org=${encodeURIComponent(org)}`);
    state.logs = records;
    applyFilter();
    if (state.query) scheduleSearch(0); // refresh content hits for new logs
    if (!silent) {
      if (!records.length && !state.uploads.length) status("No logs yet. Perform actions in the org — new logs appear automatically.", "info");
      else clearStatus();
    }
  } catch (e) {
    status(e.message, "error");
    stopPolling();
  }
}

// --- auto-capture ---------------------------------------------------------
async function ensureLogging(org) {
  try {
    const { active } = await api(`/api/trace-status?org=${encodeURIComponent(org)}`);
    if (!active) {
      status("Enabling debug logging for your user…", "info");
      const r = await api("/api/enable-logging", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ org }),
      });
      status(`Debug logging on until ${new Date(r.expiration).toLocaleTimeString()}. Watching for new logs…`, "success");
    }
    state.loggingReady = true;
  } catch (e) {
    status(`Could not enable logging: ${e.message}`, "error");
  }
}

function startPolling() {
  stopPolling();
  if (!state.auto) return;
  els.autoBtn.classList.add("pulse");
  state.pollTimer = setInterval(() => refreshLogs({ silent: true }), POLL_MS);
}
function stopPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
  els.autoBtn.classList.remove("pulse");
}

async function startCapture() {
  const org = els.orgSelect.value;
  if (!org) return;
  state.org = org;
  if (state.auto) await ensureLogging(org);
  await refreshLogs();
  startPolling();
}

function setAuto(on) {
  state.auto = on;
  els.autoBtn.textContent = on ? "● Auto-capture: ON" : "○ Auto-capture: OFF";
  els.autoBtn.className = on ? "on" : "off";
  if (on) startCapture();
  else stopPolling();
}

// --- search (one box: metadata + full text, across org logs & uploads) ----
function scheduleSearch(delay = 300) {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runContentSearch, delay);
}
function makeSnippet(body, idx, len) {
  const start = Math.max(0, idx - 40);
  const end = Math.min(body.length, idx + len + 60);
  return (start > 0 ? "…" : "") + body.slice(start, end).replace(/\s+/g, " ").trim() + (end < body.length ? "…" : "");
}
function uploadMatches(q) {
  const m = new Map();
  const lc = q.toLowerCase();
  for (const u of state.uploads) {
    const body = u.body.toLowerCase();
    const idx = body.indexOf(lc);
    if (idx >= 0) {
      const count = body.split(lc).length - 1;
      m.set(u.id, { snippet: makeSnippet(u.body, idx, q.length), count });
    }
  }
  return m;
}
async function runContentSearch() {
  const q = state.query.trim();
  const seq = ++state.searchSeq;
  if (!q) { state.contentMatches = null; els.searchInfo.textContent = ""; applyFilter(); renderLog(); return; }
  // Uploaded files are searched instantly (we already hold their text).
  const merged = uploadMatches(q);
  state.contentMatches = merged;
  applyFilter();
  // Org logs: ask the server to grep their bodies (cached server-side).
  if (state.logs.length && els.orgSelect.value) {
    els.searchInfo.textContent = "searching…";
    try {
      const { matches } = await api(`/api/search?org=${encodeURIComponent(els.orgSelect.value)}&q=${encodeURIComponent(q)}`);
      if (seq !== state.searchSeq) return; // a newer search superseded this one
      const m2 = uploadMatches(q);
      for (const mt of matches) m2.set(mt.id, mt);
      state.contentMatches = m2;
      applyFilter();
    } catch (e) {
      if (seq === state.searchSeq) status(`Search failed: ${e.message}`, "error");
    }
  }
  renderLog(); // keep the open log's highlighting in sync
  const n = state.filtered.length;
  els.searchInfo.textContent = `${n} match${n === 1 ? "" : "es"}`;
}

function applyFilter() {
  const q = state.query.trim().toLowerCase();
  const items = allItems();
  state.filtered = !q ? items : items.filter((it) => {
    const meta = [it.user, it.operation, it.status, it.id].filter(Boolean).join(" ").toLowerCase();
    if (meta.includes(q)) return true;
    return state.contentMatches ? state.contentMatches.has(it.id) : false;
  });
  renderRows();
}

function renderRows() {
  els.logRows.innerHTML = "";
  const total = state.uploads.length + state.logs.length;
  els.logCount.textContent = `${state.filtered.length} / ${total}`;
  els.listEmpty.classList.toggle("hidden", state.filtered.length > 0);
  for (const it of state.filtered) {
    const tr = document.createElement("tr");
    if (it.id === state.selectedId) tr.classList.add("selected");
    const checked = state.checked.has(it.id) ? "checked" : "";
    const pill = it.kind === "upload" ? "up" : (it.ok ? "ok" : "err");
    tr.innerHTML = `
      <td class="chk"><input type="checkbox" ${checked} /></td>
      <td>${it.kind === "upload" ? "📄 " : ""}${fmtTime(it.time)}</td>
      <td>${escapeHtml(it.user)}</td>
      <td>${escapeHtml(it.operation)}</td>
      <td><span class="status-pill ${pill}">${escapeHtml(it.status)}</span></td>
      <td>${it.duration != null ? it.duration + " ms" : ""}</td>
      <td>${fmtSize(it.size)}</td>`;
    tr.addEventListener("click", (e) => { if (!e.target.closest(".chk")) selectLog(it.id); });
    const cb = tr.querySelector("input");
    cb.addEventListener("click", (e) => e.stopPropagation());
    cb.addEventListener("change", (e) => toggleCheck(it.id, e.target.checked));
    els.logRows.appendChild(tr);

    const match = state.contentMatches && state.contentMatches.get(it.id);
    if (match && match.snippet) {
      const sr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 7;
      td.className = "snippet";
      td.innerHTML = highlightSnippet(match.snippet, state.query) +
        (match.count > 1 ? ` <span style="opacity:.7">(${match.count} hits)</span>` : "");
      sr.appendChild(td);
      sr.addEventListener("click", () => selectLog(it.id));
      els.logRows.appendChild(sr);
    }
  }
  syncSelectAll();
}

function highlightSnippet(snippet, q) {
  const esc = escapeHtml(snippet);
  if (!q) return esc;
  return esc.replace(new RegExp(rescape(q), "gi"), (m) => `<mark>${m}</mark>`);
}

// --- multi-select ---------------------------------------------------------
function toggleCheck(id, on) {
  if (on) state.checked.add(id); else state.checked.delete(id);
  updateBulkBar();
  syncSelectAll();
}
function updateBulkBar() {
  const n = state.checked.size;
  els.bulkBar.classList.toggle("hidden", n === 0);
  els.selCount.textContent = `${n} selected`;
}
function syncSelectAll() {
  const ids = state.filtered.map((i) => i.id);
  const n = ids.filter((id) => state.checked.has(id)).length;
  els.selectAll.checked = n > 0 && n === ids.length;
  els.selectAll.indeterminate = n > 0 && n < ids.length;
}
function clearSelection() { state.checked.clear(); updateBulkBar(); renderRows(); }

// --- upload ---------------------------------------------------------------
function addFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  let lastId = null, pending = files.length;
  for (const f of files) {
    const reader = new FileReader();
    reader.onload = () => {
      const id = `upload:${++uploadSeq}`;
      lastId = id;
      state.uploads.unshift({ id, name: f.name, body: String(reader.result || ""), size: f.size, when: new Date().toISOString() });
      if (--pending === 0) {
        applyFilter();
        if (state.query) scheduleSearch(0);
        if (lastId) selectLog(lastId);
        status(`Added ${files.length} file${files.length === 1 ? "" : "s"}.`, "success");
        setTimeout(clearStatus, 2000);
      }
    };
    reader.onerror = () => { if (--pending === 0) applyFilter(); };
    reader.readAsText(f);
  }
}

// --- viewer ---------------------------------------------------------------
function enableViewerTools() {
  els.analyzeBtn.disabled = false;
  els.analyzeQuestion.disabled = false;
}
async function selectLog(id) {
  state.selectedId = id;
  renderRows();
  hideAnalysis();
  const up = findUpload(id);
  if (up) {
    state.logBody = up.body;
    enableViewerTools();
    renderLog();
    return;
  }
  els.logView.innerHTML = '<span class="empty"><span class="spinner"></span> Loading log…</span>';
  try {
    const res = await fetch(`/api/logbody?org=${encodeURIComponent(state.org)}&id=${id}`);
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    state.logBody = await res.text();
    enableViewerTools();
    renderLog();
  } catch (e) {
    els.logView.innerHTML = `<span class="empty">Failed to load log: ${escapeHtml(e.message)}</span>`;
  }
}

function renderLog() {
  const q = state.query.trim();
  const body = state.logBody;
  if (body == null) return;
  // No search, or a log so large that building a highlighted DOM would hang the
  // tab: show it as plain text (fast, safe for 100k+ lines / huge single lines).
  if (!q || body.length > MAX_HIGHLIGHT_CHARS) {
    els.logView.textContent = body;
    els.matchInfo.textContent = (q && body.length > MAX_HIGHLIGHT_CHARS)
      ? "large log — highlighting off (⌘F to find)" : "";
    return;
  }
  const re = new RegExp(rescape(q), "gi");
  let html = "", last = 0, count = 0, m, capped = false;
  while ((m = re.exec(body)) !== null) {
    html += escapeHtml(body.slice(last, m.index));
    html += `<mark>${escapeHtml(m[0])}</mark>`;
    last = m.index + m[0].length; count++;
    if (m.index === re.lastIndex) re.lastIndex++;
    if (count >= MAX_MARKS) { capped = true; break; }
  }
  html += escapeHtml(body.slice(last));
  els.logView.innerHTML = html;
  els.matchInfo.textContent = count
    ? `${count}${capped ? "+" : ""} match${count === 1 ? "" : "es"} in this log`
    : "0 in this log";
  const first = els.logView.querySelector("mark");
  if (first) first.scrollIntoView({ block: "center", behavior: "smooth" });
}

// --- analysis -------------------------------------------------------------
function hideAnalysis() {
  els.analysisPanel.classList.add("hidden");
  els.resizeAnalysis.classList.add("hidden");
  // Closing the panel aborts any in-flight analysis and frees the buttons now.
  if (state.analysisAbort) { state.analysisAbort.abort(); state.analysisAbort = null; }
  els.analyzeBtn.disabled = !state.logBody;
  els.analyzeSelected.disabled = state.checked.size === 0;
}
function markdownToHtml(md) {
  const lines = escapeHtml(md).split("\n");
  let html = "", inList = false;
  const inline = (s) => s.replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      if (inList) { html += "</ul>"; inList = false; }
      html += `<h2>${inline(line.replace(/^##\s+/, ""))}</h2>`;
    } else if (/^\s*[-*]\s+/.test(line)) {
      if (!inList) { html += "<ul>"; inList = true; }
      html += `<li>${inline(line.replace(/^\s*[-*]\s+/, ""))}</li>`;
    } else if (line.trim() === "") {
      if (inList) { html += "</ul>"; inList = false; }
    } else {
      if (inList) { html += "</ul>"; inList = false; }
      html += `<p>${inline(line)}</p>`;
    }
  }
  if (inList) html += "</ul>";
  return html;
}
function trimTo(text, budget) {
  if (text.length <= budget) return text;
  const head = Math.floor(budget * 0.55);
  return text.slice(0, head) + `\n\n... [${text.length - budget} chars trimmed] ...\n\n` + text.slice(text.length - (budget - head));
}
async function getBody(id, signal) {
  const up = findUpload(id);
  if (up) return up.body;
  const res = await fetch(`/api/logbody?org=${encodeURIComponent(state.org)}&id=${id}`, { signal });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.text();
}
function labelFor(id) {
  const up = findUpload(id);
  if (up) return up.name;
  const it = allItems().find((x) => x.id === id);
  return it ? `${it.operation || "log"} · ${fmtTime(it.time)} · ${it.status}` : id;
}

function showAnalysisLoading(title) {
  els.analysisTitle.textContent = title;
  els.analysisPanel.classList.remove("hidden");
  els.resizeAnalysis.classList.remove("hidden");
  els.analysisContent.innerHTML = '<p><span class="spinner"></span> Analyzing with Claude…</p>';
}
function showAnalysisError(msg) {
  els.analysisContent.innerHTML = `<p style="color:var(--red)">${escapeHtml(msg)}</p>`;
}

function startAnalysis() {
  if (state.analysisAbort) state.analysisAbort.abort();
  const controller = new AbortController();
  state.analysisAbort = controller;
  return controller;
}
function endAnalysis(controller) {
  if (state.analysisAbort === controller) state.analysisAbort = null;
}

async function runAnalysis() {
  if (state.selectedId == null) return;
  showAnalysisLoading("Claude Analysis");
  els.analyzeBtn.disabled = true;
  const controller = startAnalysis();
  try {
    const up = findUpload(state.selectedId);
    const question = els.analyzeQuestion.value.trim();
    const payload = up
      ? { logText: up.body, question }
      : { org: state.org, id: state.selectedId, question };
    const { text } = await api("/api/analyze", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload), signal: controller.signal,
    });
    els.analysisContent.innerHTML = markdownToHtml(text);
  } catch (e) {
    if (e.name === "AbortError") return; // user closed the panel
    showAnalysisError(e.message);
  } finally {
    endAnalysis(controller);
    els.analyzeBtn.disabled = !state.logBody;
  }
}

async function analyzeSelected() {
  const ids = allItems().map((i) => i.id).filter((id) => state.checked.has(id));
  if (!ids.length) return;
  showAnalysisLoading(`Claude Analysis — ${ids.length} logs`);
  els.analyzeSelected.disabled = true;
  const controller = startAnalysis();
  try {
    const budget = Math.max(4000, Math.floor(MULTI_BUDGET / ids.length));
    const parts = [];
    for (let i = 0; i < ids.length; i++) {
      if (controller.signal.aborted) return;
      const body = await getBody(ids[i], controller.signal);
      parts.push(`===== LOG ${i + 1} of ${ids.length}: ${labelFor(ids[i])} =====\n${trimTo(body, budget)}`);
    }
    const logText = parts.join("\n\n");
    const question = els.analyzeQuestion.value.trim();
    const { text } = await api("/api/analyze", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ org: state.org, logText, question }), signal: controller.signal,
    });
    els.analysisContent.innerHTML = markdownToHtml(text);
  } catch (e) {
    if (e.name === "AbortError") return; // user closed the panel
    showAnalysisError(e.message);
  } finally {
    endAnalysis(controller);
    els.analyzeSelected.disabled = state.checked.size === 0;
  }
}

// --- model picker ---------------------------------------------------------
async function loadModel() {
  try {
    const s = await api("/api/settings");
    if (s.model) els.modelSelect.value = s.model;
  } catch {}
}
async function saveModel() {
  try {
    await api("/api/settings", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: els.modelSelect.value }),
    });
  } catch (e) { status(`Could not save model: ${e.message}`, "error"); }
}

// --- draggable pane dividers ----------------------------------------------
// dir = +1 when the resized pane is to the LEFT of the divider (dragging right
// grows it), -1 when it's to the RIGHT (dragging right shrinks it).
function makeResizer(resizer, target, dir) {
  let startX = 0, startW = 0, active = false;
  const onMove = (e) => {
    if (!active) return;
    const w = startW + (e.clientX - startX) * dir;
    target.style.width = Math.max(220, Math.min(w, window.innerWidth - 260)) + "px";
  };
  const onUp = () => {
    active = false;
    resizer.classList.remove("active");
    document.body.classList.remove("resizing");
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
  };
  resizer.addEventListener("mousedown", (e) => {
    active = true; startX = e.clientX; startW = target.getBoundingClientRect().width;
    resizer.classList.add("active");
    document.body.classList.add("resizing");
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    e.preventDefault();
  });
}

function bindDragDrop() {
  const pane = els.listPane;
  let depth = 0;
  const show = (on) => { pane.classList.toggle("dragging", on); els.dropHint.classList.toggle("hidden", !on); };
  pane.addEventListener("dragenter", (e) => { e.preventDefault(); depth++; show(true); });
  pane.addEventListener("dragover", (e) => e.preventDefault());
  pane.addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; show(false); } });
  pane.addEventListener("drop", (e) => {
    e.preventDefault(); depth = 0; show(false);
    if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files);
  });
}

function bind() {
  els.refreshBtn.addEventListener("click", () => refreshLogs());
  els.autoBtn.addEventListener("click", () => setAuto(!state.auto));
  els.uploadBtn.addEventListener("click", () => els.fileInput.click());
  els.fileInput.addEventListener("change", (e) => { addFiles(e.target.files); e.target.value = ""; });
  els.orgSelect.addEventListener("change", () => { state.org = els.orgSelect.value; state.loggingReady = false; startCapture(); });
  els.search.addEventListener("input", () => { state.query = els.search.value; applyFilter(); scheduleSearch(); });
  els.search.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); scheduleSearch(0); } });
  els.selectAll.addEventListener("change", (e) => {
    const on = e.target.checked;
    for (const it of state.filtered) { if (on) state.checked.add(it.id); else state.checked.delete(it.id); }
    updateBulkBar(); renderRows();
  });
  els.analyzeSelected.addEventListener("click", analyzeSelected);
  els.clearSelected.addEventListener("click", clearSelection);
  els.analyzeBtn.addEventListener("click", runAnalysis);
  els.analyzeQuestion.addEventListener("keydown", (e) => { if (e.key === "Enter") runAnalysis(); });
  els.closeAnalysis.addEventListener("click", hideAnalysis);
  els.modelSelect.addEventListener("change", saveModel);
  makeResizer(els.resizeMain, els.listPane, +1);
  makeResizer(els.resizeAnalysis, els.analysisPanel, -1);
  bindDragDrop();
}

async function init() {
  bind();
  loadModel();
  await loadOrgs();
  if (els.orgSelect.value) await startCapture();
  else applyFilter();
  // Keep the org list fresh (e.g. after logging into a new org in Chrome).
  setInterval(loadOrgs, 15000);
}
init();
