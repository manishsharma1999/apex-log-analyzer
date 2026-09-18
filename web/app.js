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
  logsSig: "",             // signature of the last-rendered org log set (skip no-op re-renders)
  checked: new Set(),      // ids ticked for "analyze selected together"
  query: "",               // the single search box
  contentMatches: null,    // Map(id -> {snippet,count}) for text-in-body hits
  searchSeq: 0,
  analysisAbort: null,     // AbortController for the in-flight Claude request
  analysisCtx: null,       // { logText, history:[{role,text}] } for follow-up chat
  viewMode: "raw",         // "raw" | "profile" for the log viewer
  lastProfile: null,       // last computed profile (for "✨ Explain")
  compareMode: false,      // in the ⇄ Compare two-group picker
  groupA: null,            // ids chosen for Group A while comparing
};
const POLL_MS = 5000;
const MULTI_BUDGET = 150000; // total chars sent for multi-log analysis
let uploadSeq = 0;
let searchTimer = null;

const $ = (id) => document.getElementById(id);
const els = {};
[
  "orgSelect", "refreshBtn", "autoBtn", "uploadBtn", "fileInput", "onSaveBtn", "modelSelect", "statusBar",
  "search", "searchInfo", "logCount", "logRows", "listEmpty", "listPane", "dropHint",
  "selectAll", "bulkBar", "selCount", "analyzeSelected", "downloadSelected", "compareBtn", "codeHealthBtn", "matchInfo",
  "compareBar", "compareStep", "compareCancel", "compareNext", "compareRun",
  "viewRaw", "viewProfile", "explainProfile", "logView",
  "resizeMain", "resizeAnalysis",
  "analysisPanel", "analysisTitle", "analysisContent", "closeAnalysis", "chatInput", "chatSend",
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
      opt.textContent = o.label; // org domain only — no Chrome profile suffix
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
    const sig = records.map((r) => r.id).join(",");
    // A silent poll with an unchanged log set must not re-render or re-search —
    // that full rebuild is what made the list (and search results) blink in a loop.
    if (silent && sig === state.logsSig) return;
    state.logsSig = sig;
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
// NOTE: this app never creates/enables trace flags — you manage debug logging
// yourself in Setup → Debug Logs. "Auto-capture" here just auto-refreshes the
// list so new logs your org already generates appear on their own.
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
  await refreshLogs();
  startPolling();
}

function setAuto(on) {
  state.auto = on;
  els.autoBtn.textContent = on ? "● Auto-refresh: ON" : "○ Auto-refresh: OFF";
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
  if (state.viewMode === "raw") renderLog(); // keep the open log's highlighting in sync
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
      <td class="dl"><button class="icon-btn" title="Download this log as .log">⬇</button></td>
      <td>${it.kind === "upload" ? "📄 " : ""}${fmtTime(it.time)}</td>
      <td class="usr">${escapeHtml(it.user)}</td>
      <td class="op">${escapeHtml(it.operation)}</td>
      <td><span class="status-pill ${pill}">${escapeHtml(it.status)}</span></td>
      <td class="dur">${it.duration != null ? it.duration + " ms" : ""}</td>
      <td class="size">${fmtSize(it.size)}</td>`;
    tr.addEventListener("click", (e) => { if (!e.target.closest(".chk") && !e.target.closest(".dl")) selectLog(it.id); });
    const cb = tr.querySelector(".chk input");
    cb.addEventListener("click", (e) => e.stopPropagation());
    cb.addEventListener("change", (e) => toggleCheck(it.id, e.target.checked));
    const dl = tr.querySelector(".dl button");
    dl.addEventListener("click", (e) => { e.stopPropagation(); downloadLog(it.id); });
    els.logRows.appendChild(tr);

    const match = state.contentMatches && state.contentMatches.get(it.id);
    if (match && match.snippet) {
      const sr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 8;
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
  // While picking logs to compare, the compare bar owns the sub-header instead.
  if (state.compareMode) { els.bulkBar.classList.add("hidden"); return; }
  const n = state.checked.size;
  const hasOpen = state.selectedId != null;
  // The bar (and analyze button) shows when logs are ticked OR a log is simply
  // open in the viewer — clicking any row is enough to analyze that one log.
  els.bulkBar.classList.toggle("hidden", n === 0 && !hasOpen);
  // How many logs the analyze button will act on: the ticked set, or the open log.
  const target = n > 0 ? n : (hasOpen ? 1 : 0);
  els.selCount.textContent = n > 0 ? `${n} selected` : (hasOpen ? "Viewing 1 log" : "");
  els.analyzeSelected.textContent = target === 1 ? "✨ Analyze this log" : `✨ Analyze ${target} logs`;
  const busy = !!state.analysisAbort;
  // Enable whenever there's a target (disabled only while an analysis is running).
  els.analyzeSelected.disabled = target === 0 || busy;
  els.codeHealthBtn.disabled = target === 0 || busy;
  els.compareBtn.disabled = busy;
  // Download appears only for a multi-selection (a single log uses its per-row ⬇ icon).
  els.downloadSelected.classList.toggle("hidden", n < 2);
}
function syncSelectAll() {
  const ids = state.filtered.map((i) => i.id);
  const n = ids.filter((id) => state.checked.has(id)).length;
  // The header box is ticked ONLY when every shown log is selected — a partial
  // selection leaves it unchecked (no "indeterminate" dash that looks ticked).
  els.selectAll.checked = ids.length > 0 && n === ids.length;
  els.selectAll.indeterminate = false;
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

// --- download -------------------------------------------------------------
function triggerDownload(name, text) {
  const blob = new Blob([text], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
async function fetchBodyFor(id) {
  const up = findUpload(id);
  if (up) return { body: up.body, name: /\.log$/i.test(up.name) ? up.name : `${up.name}.log` };
  const res = await fetch(`/api/logbody?org=${encodeURIComponent(state.org)}&id=${id}`);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  // Salesforce ApexLog Id (starts with 07L) as the filename — just <id>.log.
  return { body: await res.text(), name: `${id}.log` };
}
async function downloadLog(id) {
  try {
    const { body, name } = await fetchBodyFor(id);
    triggerDownload(name, body);
  } catch (e) { status(`Download failed: ${e.message}`, "error"); }
}
async function downloadSelected() {
  const ids = allItems().map((i) => i.id).filter((id) => state.checked.has(id));
  if (!ids.length) return;
  status(`Downloading ${ids.length} log${ids.length === 1 ? "" : "s"}…`, "info");
  for (const id of ids) {
    await downloadLog(id);
    await new Promise((r) => setTimeout(r, 350)); // stagger so the browser doesn't block them
  }
  status(`Downloaded ${ids.length} log${ids.length === 1 ? "" : "s"}.`, "success");
  setTimeout(clearStatus, 2000);
}

// Clear everything tied to the previously-selected org (kept: uploaded files,
// which are org-independent). Used when switching orgs so no stale log/analysis
// lingers even if the new org fails to load.
function resetView() {
  state.logs = [];
  state.logsSig = "";
  state.selectedId = null;
  state.logBody = "";
  state.checked.clear();
  state.contentMatches = null;
  state.lastProfile = null;
  if (state.compareMode) exitCompareMode();
  hideAnalysis();
  els.logView.className = "log-view";
  els.logView.innerHTML = '<span class="empty">Select a log on the left to view it.</span>';
  els.explainProfile.classList.add("hidden");
  els.matchInfo.textContent = "";
  els.searchInfo.textContent = "";
  updateBulkBar();
  applyFilter();
}

// --- viewer ---------------------------------------------------------------
async function selectLog(id) {
  state.selectedId = id;
  renderRows();
  updateBulkBar();  // surface "Analyze this log" for the just-opened log
  const up = findUpload(id);
  if (up) {
    state.logBody = up.body;
    renderCurrentView();
    return;
  }
  els.logView.innerHTML = '<span class="empty"><span class="spinner"></span> Loading log…</span>';
  try {
    const res = await fetch(`/api/logbody?org=${encodeURIComponent(state.org)}&id=${id}`);
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    state.logBody = await res.text();
    renderCurrentView();
  } catch (e) {
    els.logView.innerHTML = `<span class="empty">Failed to load log: ${escapeHtml(e.message)}</span>`;
  }
}

// --- Apex debug-log syntax highlighting -----------------------------------
// Colour class for an event token (the ALL_CAPS word after the timestamp).
function eventClass(ev) {
  if (/ERROR|EXCEPTION|FATAL|FAIL|ABORT/.test(ev)) return "t-err";
  if (ev === "USER_DEBUG") return "t-debug";
  if (/SOQL|SOSL|DML|QUERY/.test(ev)) return "t-soql";
  if (/ENTRY|BEGIN|STARTED|INVOCATION/.test(ev)) return "t-enter";
  if (/EXIT|END|FINISHED/.test(ev)) return "t-exit";
  if (/LIMIT|HEAP|CUMULATIVE|STATISTICS/.test(ev)) return "t-limit";
  return "t-event";
}
// Split the remainder of a line into segments, colouring | separators and [42]
// line references.
function apexFields(rest) {
  const out = [];
  const re = /(\|)|(\[\d+\])/g;
  let last = 0, m;
  while ((m = re.exec(rest)) !== null) {
    if (m.index > last) out.push({ text: rest.slice(last, m.index), cls: null });
    out.push(m[1] ? { text: "|", cls: "t-punc" } : { text: m[2], cls: "t-lineref" });
    last = m.index + m[0].length;
  }
  if (last < rest.length) out.push({ text: rest.slice(last), cls: null });
  return out;
}
// Tokenize one log line into {text, cls} segments for colouring.
function tokenizeApex(line) {
  if (!line) return [];
  const ts = line.match(/^(\d{2}:\d{2}:\d{2}\.\d+ \(\d+\))\|/);
  if (ts) {
    const segs = [{ text: ts[1], cls: "t-time" }, { text: "|", cls: "t-punc" }];
    let rest = line.slice(ts[0].length);
    const ev = rest.match(/^([A-Z][A-Z0-9_]+)/);
    if (ev) { segs.push({ text: ev[1], cls: eventClass(ev[1]) }); rest = rest.slice(ev[1].length); }
    return segs.concat(apexFields(rest));
  }
  if (/^\d+\.\d+ [A-Z]/.test(line)) return [{ text: line, cls: "t-time" }]; // header line
  return [{ text: line, cls: null }];
}
// Escape a raw segment and wrap query matches in <mark> (capped so a query that
// hits thousands of times can't spawn thousands of DOM nodes).
function markSegment(text, re, counter) {
  if (!re || counter.n >= MAX_MARKS) return escapeHtml(text);
  let html = "", last = 0, m;
  re.lastIndex = 0;
  while ((m = re.exec(text)) !== null) {
    if (counter.n >= MAX_MARKS) { counter.capped = true; break; }
    html += escapeHtml(text.slice(last, m.index)) + `<mark>${escapeHtml(m[0])}</mark>`;
    last = m.index + m[0].length; counter.n++;
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  return html + escapeHtml(text.slice(last));
}

function renderLog() {
  const q = state.query.trim();
  const body = state.logBody;
  if (body == null) return;
  // Very large logs: fast plain text (no gutter/colours) so the tab never freezes.
  if (body.length > MAX_HIGHLIGHT_CHARS) {
    els.logView.className = "log-view plain";
    els.logView.textContent = body;
    els.matchInfo.textContent = q ? "large log — highlighting off (⌘F to find)" : "";
    return;
  }
  const re = q ? new RegExp(rescape(q), "gi") : null;
  const counter = { n: 0, capped: false };
  const lines = body.split("\n");
  const out = ['<div class="code-lines">'];
  for (const line of lines) {
    let h = "";
    for (const seg of tokenizeApex(line)) {
      const inner = markSegment(seg.text, re, counter);
      h += seg.cls ? `<span class="${seg.cls}">${inner}</span>` : inner;
    }
    out.push(`<div class="cline">${h || "&nbsp;"}</div>`);
  }
  out.push("</div>");
  els.logView.className = "log-view code";
  els.logView.innerHTML = out.join("");
  els.matchInfo.textContent = !q ? "" : counter.n
    ? `${counter.n}${counter.capped ? "+" : ""} match${counter.n === 1 ? "" : "es"} in this log`
    : "0 in this log";
  const first = els.logView.querySelector("mark");
  if (first) first.scrollIntoView({ block: "center", behavior: "smooth" });
}

// --- performance profiler (⏱ Profile) -------------------------------------
function setViewMode(mode) {
  state.viewMode = mode;
  els.viewRaw.classList.toggle("on", mode === "raw");
  els.viewProfile.classList.toggle("on", mode === "profile");
  renderCurrentView();
}
function renderCurrentView() {
  if (state.viewMode === "profile") renderProfile();
  else { renderLog(); els.explainProfile.classList.add("hidden"); }
}

// Parse method/SOQL/DML timings and governor limits from a raw Apex log.
// Timings use the nanosecond counter in each line's "(12345678)" prefix.
// Different Apex log events carry the meaningful label in different fields, so
// derive a clean row name per event type (avoids leading record ids / entry-point noise).
function unitName(ev, parts) {
  const last = (parts[parts.length - 1] || "").trim();
  if (ev === "SOQL_EXECUTE_BEGIN") return last;                    // the query itself
  if (ev === "DML_BEGIN") return "DML " + parts.slice(3).join(" ").trim();
  if (ev === "CODE_UNIT_STARTED") {                                // prefer a human label field
    for (let i = parts.length - 1; i >= 2; i--) {
      const f = (parts[i] || "").trim();
      if (f && !/^01p|^__sfdc|^\[|^EXTERNAL$/.test(f)) return f;
    }
    return last;
  }
  return last;                                                     // METHOD/CONSTRUCTOR/SYSTEM_METHOD signature
}
function buildProfile(body) {
  const ENTRY = {
    METHOD_ENTRY: 1, CONSTRUCTOR_ENTRY: 1, SYSTEM_METHOD_ENTRY: 1,
    CODE_UNIT_STARTED: 1, SOQL_EXECUTE_BEGIN: 1, DML_BEGIN: 1,
  };
  const EXIT = {
    METHOD_EXIT: 1, CONSTRUCTOR_EXIT: 1, SYSTEM_METHOD_EXIT: 1,
    CODE_UNIT_FINISHED: 1, SOQL_EXECUTE_END: 1, DML_END: 1,
  };
  const stack = [], agg = new Map();
  let firstNs = null, lastNs = null, soql = 0, dml = 0;
  for (const line of body.split("\n")) {
    if (line.indexOf("|") < 0) continue;
    const parts = line.split("|");
    const ev = parts[1];
    const nm = parts[0].match(/\((\d+)\)/);
    const ns = nm ? Number(nm[1]) : null;
    if (ns != null) { if (firstNs == null) firstNs = ns; lastNs = ns; }
    if (ENTRY[ev]) {
      if (ev === "SOQL_EXECUTE_BEGIN") soql++;
      if (ev === "DML_BEGIN") dml++;
      const name = (unitName(ev, parts) || ev).slice(0, 200);
      stack.push({ name, start: ns, child: 0 });
    } else if (EXIT[ev] && stack.length) {
      const top = stack.pop();
      const dur = (ns != null && top.start != null) ? ns - top.start : 0;
      const rec = agg.get(top.name) || { name: top.name, total: 0, self: 0, count: 0 };
      rec.total += dur; rec.self += dur - top.child; rec.count++;
      agg.set(top.name, rec);
      if (stack.length) stack[stack.length - 1].child += dur;
    }
  }
  const rows = [...agg.values()].sort((a, b) => b.total - a.total).slice(0, 20);
  return { rows, totalNs: (firstNs != null && lastNs != null) ? lastNs - firstNs : 0, soql, dml, limits: parseLimits(body) };
}
function parseLimits(body) {
  const out = new Map();
  const re = /(?:Number of|Maximum) ([^:]+):\s*(\d+) out of (\d+)/;
  for (const l of body.split("\n")) {
    const m = l.match(re);
    if (!m) continue;
    const label = m[1].trim(), used = +m[2], max = +m[3];
    const prev = out.get(label);
    if (!prev || used > prev.used) out.set(label, { label, used, max });
  }
  return [...out.values()];
}
function renderProfile() {
  els.logView.className = "log-view profile-view";
  els.explainProfile.classList.toggle("hidden", state.selectedId == null || !state.logBody);
  if (!state.logBody) { els.logView.innerHTML = '<div class="empty">Select a log to profile it.</div>'; return; }
  const p = buildProfile(state.logBody);
  state.lastProfile = p;
  const ms = (ns) => (ns / 1e6).toFixed(1);
  let h = '<div class="profile"><h3>Overview</h3><table class="prof-table"><tbody>';
  h += `<tr><td>Wall time</td><td class="num">${ms(p.totalNs)} ms</td></tr>`;
  h += `<tr><td>SOQL queries</td><td class="num">${p.soql}</td></tr>`;
  h += `<tr><td>DML statements</td><td class="num">${p.dml}</td></tr></tbody></table>`;
  if (p.limits.length) {
    h += '<h3>Governor limits</h3><table class="prof-table"><thead><tr><th>Limit</th><th class="num">Used</th><th class="num">Max</th><th>%</th></tr></thead><tbody>';
    for (const l of p.limits) {
      const pct = l.max ? Math.round(100 * l.used / l.max) : 0;
      const cls = pct >= 90 ? "lim-hot" : pct >= 75 ? "lim-warn" : "lim-ok";
      h += `<tr class="${cls}"><td>${escapeHtml(l.label)}</td><td class="num">${l.used}</td><td class="num">${l.max}</td>` +
           `<td><span class="bar" style="width:${Math.min(100, Math.max(2, pct))}px"></span>${pct}%</td></tr>`;
    }
    h += "</tbody></table>";
  }
  if (p.rows.length) {
    h += '<h3>Slowest operations</h3><table class="prof-table"><thead><tr><th>Operation</th><th class="num">Total ms</th><th class="num">Self ms</th><th class="num">Calls</th></tr></thead><tbody>';
    for (const r of p.rows) {
      h += `<tr><td class="prof-name" title="${escapeHtml(r.name)}">${escapeHtml(r.name)}</td>` +
           `<td class="num">${ms(r.total)}</td><td class="num">${ms(r.self)}</td><td class="num">${r.count}</td></tr>`;
    }
    h += "</tbody></table>";
  } else {
    h += '<p class="hint">No METHOD_ENTRY/EXIT timing found — turn on Apex Code (FINE) + Profiling in your debug level to capture method timings.</p>';
  }
  els.logView.innerHTML = h + "</div>";
}
async function explainProfile() {
  if (state.selectedId == null || !state.lastProfile) return;
  const p = state.lastProfile, ms = (ns) => (ns / 1e6).toFixed(1);
  let summary = `Performance profile for log ${labelFor(state.selectedId)}:\n` +
    `Wall ${ms(p.totalNs)}ms, SOQL ${p.soql}, DML ${p.dml}.\n\nGovernor limits:\n` +
    p.limits.map((l) => `- ${l.label}: ${l.used}/${l.max}`).join("\n") +
    `\n\nSlowest operations (total ms / self ms / calls):\n` +
    p.rows.slice(0, 15).map((r) => `- ${r.name}: ${ms(r.total)} / ${ms(r.self)} / ${r.count}`).join("\n");
  // Send the RAW log as context (so server-side enrichment + follow-ups like
  // "which user ran this" / query plans work) and put the profile in the question.
  const logText = state.logBody || summary;
  await runPanel("⏱ Profile — Claude", async (signal) => {
    const { text } = await api("/api/analyze", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        org: state.org, logText, freeform: true, history: [],
        question: "Here is a performance profile computed from the attached debug log:\n\n" + summary +
          "\n\nExplain this profile: what's slow, what's near a governor limit, and how to fix it.",
      }),
      signal,
    });
    return { text, chatLogText: logText };
  });
}

// --- analysis -------------------------------------------------------------
function hideAnalysis() {
  els.analysisPanel.classList.add("hidden");
  els.resizeAnalysis.classList.add("hidden");
  // Closing the panel aborts any in-flight analysis and frees the buttons now.
  if (state.analysisAbort) { state.analysisAbort.abort(); state.analysisAbort = null; }
  updateBulkBar();
  setChatEnabled(false);
  state.analysisCtx = null;
}
function setChatEnabled(on) {
  els.chatInput.disabled = !on;
  els.chatSend.disabled = !on;
}
function markdownToHtml(md) {
  const inline = (s) =>
    s.replace(/`([^`]+)`/g, "<code>$1</code>")
     .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  const rawLines = String(md).split("\n");
  let html = "", listType = null;      // null | "ul" | "ol"
  const closeList = () => { if (listType) { html += `</${listType}>`; listType = null; } };
  const openList = (t) => { if (listType !== t) { closeList(); html += `<${t}>`; listType = t; } };

  const isTableRow = (s) => /^\s*\|.*\|\s*$/.test(s);
  const splitRow = (r) => r.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    // Fenced code block ``` ... ``` (optionally with a language) -> <pre><code>.
    const fence = line.match(/^\s*```(\w+)?\s*$/);
    if (fence) {
      closeList();
      const code = [];
      i++;
      while (i < rawLines.length && !/^\s*```\s*$/.test(rawLines[i])) { code.push(rawLines[i]); i++; }
      html += `<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`;
      continue;
    }
    // GFM table: a header row, a |---|---| separator, then body rows.
    if (isTableRow(line) && i + 1 < rawLines.length &&
        /^\s*\|?[\s:|-]+\|?\s*$/.test(rawLines[i + 1]) && rawLines[i + 1].includes("-")) {
      closeList();
      const headers = splitRow(line);
      i += 2; // skip header + separator
      let t = `<table class="md-table"><thead><tr>${headers.map((h) => `<th>${inline(escapeHtml(h))}</th>`).join("")}</tr></thead><tbody>`;
      while (i < rawLines.length && isTableRow(rawLines[i])) {
        t += `<tr>${splitRow(rawLines[i]).map((c) => `<td>${inline(escapeHtml(c))}</td>`).join("")}</tr>`;
        i++;
      }
      i--; // the for-loop will i++ past the last consumed row
      html += t + "</tbody></table>";
      continue;
    }
    const ol = line.match(/^\s*(\d+)\.\s+(.*)$/);
    if (/^###\s+/.test(line)) { closeList(); html += `<h3>${inline(escapeHtml(line.replace(/^###\s+/, "")))}</h3>`; }
    else if (/^##\s+/.test(line)) { closeList(); html += `<h2>${inline(escapeHtml(line.replace(/^##\s+/, "")))}</h2>`; }
    else if (/^#\s+/.test(line)) { closeList(); html += `<h2>${inline(escapeHtml(line.replace(/^#\s+/, "")))}</h2>`; }
    // Keep the source number via value=, so numbering survives a code block or
    // paragraph splitting the list (otherwise every item restarts at 1).
    else if (ol) { openList("ol"); html += `<li value="${ol[1]}">${inline(escapeHtml(ol[2]))}</li>`; }
    else if (/^\s*[-*]\s+/.test(line)) { openList("ul"); html += `<li>${inline(escapeHtml(line.replace(/^\s*[-*]\s+/, "")))}</li>`; }
    else if (line.trim() === "") { closeList(); }
    else { closeList(); html += `<p>${inline(escapeHtml(line))}</p>`; }
  }
  closeList();
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

// Playful "working…" words (like the CLI shows) cycled while Claude thinks.
const THINKING_WORDS = [
  "Cerebrating", "Hallowing", "Pondering", "Ruminating", "Percolating",
  "Conjuring", "Noodling", "Finagling", "Musing", "Marinating", "Simmering",
  "Contemplating", "Deliberating", "Puzzling", "Untangling", "Sleuthing",
  "Divining", "Cogitating", "Synthesizing", "Scheming", "Deciphering", "Unravelling",
];
let thinkingTimer = null;
function startThinking(el) {
  stopThinking();
  const spin = () => {
    const w = THINKING_WORDS[Math.floor(Math.random() * THINKING_WORDS.length)];
    el.innerHTML = `<span class="spinner"></span> <span class="thinking">${w}…</span>`;
  };
  spin();
  thinkingTimer = setInterval(spin, 2200);
}
function stopThinking() { if (thinkingTimer) { clearInterval(thinkingTimer); thinkingTimer = null; } }

function showAnalysisLoading(title) {
  els.analysisTitle.textContent = title;
  els.analysisPanel.classList.remove("hidden");
  els.resizeAnalysis.classList.remove("hidden");
  startThinking(els.analysisContent);
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

// Ids the analyze/code-health buttons act on: the ticked set, or the open log.
function selectionIds() {
  const ids = allItems().map((i) => i.id).filter((id) => state.checked.has(id));
  if (!ids.length && state.selectedId != null) return [state.selectedId];
  return ids;
}
// Concatenate the bodies of several logs into one budgeted block with markers.
async function collectLogText(ids, signal) {
  const budget = Math.max(4000, Math.floor(MULTI_BUDGET / ids.length));
  const parts = [];
  for (let i = 0; i < ids.length; i++) {
    if (signal && signal.aborted) throw new DOMException("aborted", "AbortError");
    const body = await getBody(ids[i], signal);
    parts.push(`===== LOG ${i + 1} of ${ids.length}: ${labelFor(ids[i])} =====\n${trimTo(body, budget)}`);
  }
  return parts.join("\n\n");
}

// Generic Claude-panel runner. `fetcher(signal)` returns { text, chatLogText? };
// when chatLogText is present, follow-up chat is enabled over those logs.
async function runPanel(title, fetcher) {
  showAnalysisLoading(title);
  setChatEnabled(false);
  const controller = startAnalysis();
  updateBulkBar(); // reflect the running state on the action buttons
  try {
    const out = await fetcher(controller.signal);
    els.analysisContent.innerHTML = markdownToHtml(out.text);
    if (out.chatLogText != null) {
      state.analysisCtx = { logText: out.chatLogText, history: [{ role: "assistant", text: out.text }] };
      setChatEnabled(true);
      els.chatInput.focus();
    } else {
      state.analysisCtx = null;
    }
  } catch (e) {
    if (e.name === "AbortError") return; // user closed the panel
    showAnalysisError(e.message);
  } finally {
    stopThinking();
    endAnalysis(controller);
    updateBulkBar();
  }
}

// Analyze a specific set of log ids (one or many), then enable follow-up chat.
function runAnalysisFor(ids) {
  if (!ids.length) return;
  return runPanel(ids.length === 1 ? "Claude Analysis" : `Claude Analysis — ${ids.length} logs`, async (signal) => {
    const logText = await collectLogText(ids, signal);
    const { text } = await api("/api/analyze", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ org: state.org, logText }), signal,
    });
    return { text, chatLogText: logText };
  });
}

// One dynamic button: analyze every ticked log, or — if nothing is ticked — the
// log currently open in the viewer (label reflects how many).
function analyzeSelected() { return runAnalysisFor(selectionIds()); }

// #11 Code Health — review the Apex that executed in the selected/open log(s).
function runCodeHealth() {
  const ids = selectionIds();
  if (!ids.length) return;
  return runPanel("🩺 Code Health", async (signal) => {
    const logText = await collectLogText(ids, signal);
    const { text } = await api("/api/codehealth", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ org: state.org, logText }), signal,
    });
    return { text, chatLogText: logText };
  });
}

// #9 Compare — a two-step picker: choose Group A, then Group B, then compare.
function enterCompareMode() {
  state.compareMode = true;
  state.groupA = null;
  state.checked.clear();
  els.bulkBar.classList.add("hidden");
  els.compareBar.classList.remove("hidden");
  els.compareStep.textContent = "Step 1 — tick the log(s) for Group A (baseline), then Next ▶";
  els.compareNext.classList.remove("hidden");
  els.compareRun.classList.add("hidden");
  renderRows();
}
function exitCompareMode() {
  state.compareMode = false;
  state.groupA = null;
  state.checked.clear();
  els.compareBar.classList.add("hidden");
  renderRows();
  updateBulkBar();
}
function compareNext() {
  const a = [...state.checked];
  if (!a.length) { status("Tick at least one log for Group A.", "error"); return; }
  state.groupA = a;
  state.checked.clear();
  renderRows();
  els.compareStep.textContent = `Group A: ${a.length} log(s) ✓ — Step 2: tick the log(s) for Group B, then Compare.`;
  els.compareNext.classList.add("hidden");
  els.compareRun.classList.remove("hidden");
}
function compareRun() {
  const b = [...state.checked];
  if (!b.length) { status("Tick at least one log for Group B.", "error"); return; }
  const a = state.groupA || [];
  exitCompareMode();
  return runPanel(`⇄ Compare — A(${a.length}) vs B(${b.length})`, async (signal) => {
    const groupA = await collectLogText(a, signal);
    const groupB = await collectLogText(b, signal);
    const { text } = await api("/api/compare", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ groupA, groupB }), signal,
    });
    return { text, chatLogText: `===== GROUP A =====\n${groupA}\n\n===== GROUP B =====\n${groupB}` };
  });
}

// #12 On Save — pick an object, show what automation fires on save.
async function openOnSave() {
  if (!state.org) { status("Select a Salesforce org first.", "error"); return; }
  const overlay = document.createElement("div");
  overlay.className = "modal";
  overlay.innerHTML = `
    <div class="modal-card">
      <h2>🔀 What fires on save</h2>
      <label>Object
        <select id="onSaveObj"><option>Loading objects…</option></select>
      </label>
      <p class="hint">Reads this object's triggers, record-triggered flows, validation &amp; workflow rules (read-only) and asks Claude to lay out the order of execution.</p>
      <div class="modal-actions">
        <button id="onSaveCancel">Cancel</button>
        <button id="onSaveGo" class="primary" disabled>Analyze</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const sel = overlay.querySelector("#onSaveObj");
  const go = overlay.querySelector("#onSaveGo");
  const close = () => overlay.remove();
  overlay.querySelector("#onSaveCancel").addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  try {
    const { objects } = await api(`/api/objects?org=${encodeURIComponent(state.org)}`);
    sel.innerHTML = "";
    for (const o of objects) {
      const opt = document.createElement("option");
      opt.value = o.name; opt.textContent = `${o.label} (${o.name})`;
      sel.appendChild(opt);
    }
    go.disabled = !objects.length;
    if (!objects.length) sel.innerHTML = "<option>No triggerable objects found</option>";
  } catch (e) {
    sel.innerHTML = `<option>${escapeHtml(e.message)}</option>`;
  }
  go.addEventListener("click", () => {
    const sobject = sel.value;
    close();
    runPanel(`🔀 On Save — ${sobject}`, async (signal) => {
      const { text } = await api("/api/onsave", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ org: state.org, sobject }), signal,
      });
      return { text, chatLogText: null };
    });
  });
}

// --- follow-up chat -------------------------------------------------------
function appendChat(role, html) {
  const wrap = document.createElement("div");
  wrap.className = `chat-turn ${role}`;
  const label = document.createElement("div");
  label.className = "chat-role";
  label.textContent = role === "user" ? "You" : "Claude";
  const bubble = document.createElement("div");
  bubble.className = "chat-bubble";
  bubble.innerHTML = html;
  wrap.appendChild(label);
  wrap.appendChild(bubble);
  els.analysisContent.appendChild(wrap);
  els.analysisContent.scrollTop = els.analysisContent.scrollHeight;
  return bubble;
}
async function sendChat() {
  const q = els.chatInput.value.trim();
  if (!q || !state.analysisCtx) return;
  els.chatInput.value = "";
  appendChat("user", escapeHtml(q));
  const bubble = appendChat("assistant", '<span class="spinner"></span>');
  startThinking(bubble);
  setChatEnabled(false);
  const controller = startAnalysis();
  try {
    const { text } = await api("/api/analyze", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        org: state.org, logText: state.analysisCtx.logText,
        question: q, freeform: true, history: state.analysisCtx.history,
      }),
      signal: controller.signal,
    });
    bubble.innerHTML = markdownToHtml(text);
    state.analysisCtx.history.push({ role: "user", text: q }, { role: "assistant", text });
  } catch (e) {
    if (e.name === "AbortError") { bubble.closest(".chat-turn").remove(); return; }
    bubble.innerHTML = `<span style="color:var(--red)">${escapeHtml(e.message)}</span>`;
  } finally {
    stopThinking();
    endAnalysis(controller);
    if (state.analysisCtx) { setChatEnabled(true); els.chatInput.focus(); }
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
  els.orgSelect.addEventListener("change", () => { state.org = els.orgSelect.value; resetView(); startCapture(); });
  els.search.addEventListener("input", () => { state.query = els.search.value; applyFilter(); scheduleSearch(); });
  els.search.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); scheduleSearch(0); } });
  els.selectAll.addEventListener("change", (e) => {
    const on = e.target.checked;
    for (const it of state.filtered) { if (on) state.checked.add(it.id); else state.checked.delete(it.id); }
    updateBulkBar(); renderRows();
  });
  els.analyzeSelected.addEventListener("click", analyzeSelected);
  els.downloadSelected.addEventListener("click", downloadSelected);
  els.codeHealthBtn.addEventListener("click", runCodeHealth);
  els.compareBtn.addEventListener("click", enterCompareMode);
  els.compareCancel.addEventListener("click", exitCompareMode);
  els.compareNext.addEventListener("click", compareNext);
  els.compareRun.addEventListener("click", compareRun);
  els.onSaveBtn.addEventListener("click", openOnSave);
  els.viewRaw.addEventListener("click", () => setViewMode("raw"));
  els.viewProfile.addEventListener("click", () => setViewMode("profile"));
  els.explainProfile.addEventListener("click", explainProfile);
  els.closeAnalysis.addEventListener("click", hideAnalysis);
  // Cmd/Ctrl+A inside the log view selects ONLY the log text, not the page.
  els.logView.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && (e.key === "a" || e.key === "A")) {
      e.preventDefault();
      const range = document.createRange();
      range.selectNodeContents(els.logView);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
  });
  els.chatSend.addEventListener("click", sendChat);
  els.chatInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); sendChat(); } });
  els.modelSelect.addEventListener("change", saveModel);
  makeResizer(els.resizeMain, els.listPane, +1);
  makeResizer(els.resizeAnalysis, els.analysisPanel, -1);
  bindDragDrop();
}

// Tell the server we're alive so it can shut itself down when the tab closes.
// Beat immediately (this cancels any pending shutdown from a page reload), keep
// beating, and fire a "bye" beacon on close/navigation.
function bindLifecycle() {
  const beat = () => fetch("/api/heartbeat").catch(() => {});
  beat();
  setInterval(beat, 5000);
  window.addEventListener("pagehide", () => { try { navigator.sendBeacon("/api/bye"); } catch {} });
}

async function init() {
  bind();
  bindLifecycle();
  loadModel();
  await loadOrgs();
  if (els.orgSelect.value) await startCapture();
  else applyFilter();
  // Keep the org list fresh (e.g. after logging into a new org in Chrome).
  setInterval(loadOrgs, 15000);
}
init();
