// Front-end for the local Apex Log Analyzer. Talks to the Node server's /api/*
// endpoints; the server does the Salesforce (via sf CLI) and Claude calls.

const state = {
  org: null,
  logs: [],
  filtered: [],
  selectedId: null,
  logBody: "",
  matches: [],
  matchIndex: -1,
  auto: true,
  pollTimer: null,
  loggingReady: false,
  contentMatches: null, // Map(logId -> {snippet,count}) when a content search is active
  contentQuery: "",
};
const POLL_MS = 5000;

const $ = (id) => document.getElementById(id);
const els = {};
[
  "orgSelect", "refreshBtn", "autoBtn", "settingsBtn", "statusBar",
  "listFilter", "logCount", "logRows", "listEmpty",
  "contentSearch", "contentClear", "searchInfo",
  "logSearch", "matchInfo", "prevMatch", "nextMatch",
  "analyzeQuestion", "analyzeBtn", "logView",
  "analysisPanel", "analysisContent", "closeAnalysis",
  "settingsModal", "apiKeyInput", "modelSelect", "saveSettings", "cancelSettings", "keyHint",
].forEach((id) => (els[id] = $(id)));

// --- helpers --------------------------------------------------------------
function status(msg, kind = "info") {
  els.statusBar.textContent = msg;
  els.statusBar.className = `status ${kind}`;
}
function clearStatus() { els.statusBar.className = "status hidden"; }
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) =>
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
async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

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
      status("No org detected. Log into a Salesforce org in Chrome, then Refresh.", "info");
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
    clearStatus();
  } catch (e) {
    status(e.message, "error");
  }
}

// --- log list -------------------------------------------------------------
async function refreshLogs({ silent } = {}) {
  const org = els.orgSelect.value;
  if (!org) return status("Log into a Salesforce org in Chrome first.", "info");
  state.org = org;
  try {
    if (!silent) status("Loading logs…", "info");
    const { records } = await api(`/api/logs?org=${encodeURIComponent(org)}`);
    state.logs = records;
    applyFilter();
    if (!silent) {
      if (!records.length) status("No logs yet. Perform actions in the org — new logs appear automatically.", "info");
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

function applyFilter() {
  let base = state.logs;
  // Content-search results (bodies) narrow the list first, if active.
  if (state.contentMatches) base = base.filter((l) => state.contentMatches.has(l.Id));
  const q = els.listFilter.value.trim().toLowerCase();
  state.filtered = !q ? base : base.filter((l) => {
    const hay = [l.LogUser && l.LogUser.Name, l.Operation, l.Application, l.Status, l.Request]
      .filter(Boolean).join(" ").toLowerCase();
    return hay.includes(q);
  });
  renderRows();
}

// --- content search (across all log bodies) -------------------------------
async function runContentSearch() {
  const q = els.contentSearch.value.trim();
  const org = els.orgSelect.value;
  state.contentQuery = q;
  if (!q) return clearContentSearch();
  if (!org) return;
  els.contentClear.classList.remove("hidden");
  els.searchInfo.textContent = "searching…";
  try {
    const { matches } = await api(`/api/search?org=${encodeURIComponent(org)}&q=${encodeURIComponent(q)}`);
    state.contentMatches = new Map(matches.map((m) => [m.id, m]));
    els.searchInfo.textContent = `${matches.length} log${matches.length === 1 ? "" : "s"} contain “${q}”`;
    applyFilter();
  } catch (e) {
    els.searchInfo.textContent = "";
    status(`Search failed: ${e.message}`, "error");
  }
}
function clearContentSearch() {
  state.contentMatches = null;
  state.contentQuery = "";
  els.contentSearch.value = "";
  els.searchInfo.textContent = "";
  els.contentClear.classList.add("hidden");
  applyFilter();
}

function renderRows() {
  els.logRows.innerHTML = "";
  els.logCount.textContent = `${state.filtered.length} / ${state.logs.length}`;
  els.listEmpty.classList.toggle("hidden", state.filtered.length > 0);
  for (const log of state.filtered) {
    const tr = document.createElement("tr");
    if (log.Id === state.selectedId) tr.classList.add("selected");
    const ok = (log.Status || "").toLowerCase() === "success";
    tr.innerHTML = `
      <td>${fmtTime(log.StartTime)}</td>
      <td>${escapeHtml((log.LogUser && log.LogUser.Name) || "")}</td>
      <td>${escapeHtml(log.Operation || "")}</td>
      <td><span class="status-pill ${ok ? "ok" : "err"}">${escapeHtml(log.Status || "")}</span></td>
      <td>${log.DurationMilliseconds != null ? log.DurationMilliseconds + " ms" : ""}</td>
      <td>${fmtSize(log.LogLength)}</td>`;
    tr.addEventListener("click", () => selectLog(log.Id));
    els.logRows.appendChild(tr);

    const match = state.contentMatches && state.contentMatches.get(log.Id);
    if (match && match.snippet) {
      const sr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 6;
      td.className = "snippet";
      td.innerHTML = highlightSnippet(match.snippet, state.contentQuery) +
        (match.count > 1 ? ` <span style="opacity:.7">(${match.count} hits)</span>` : "");
      sr.appendChild(td);
      sr.addEventListener("click", () => selectLog(log.Id));
      els.logRows.appendChild(sr);
    }
  }
}

function highlightSnippet(snippet, q) {
  const esc = escapeHtml(snippet);
  if (!q) return esc;
  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  return esc.replace(re, (m) => `<mark>${m}</mark>`);
}

// --- viewer ---------------------------------------------------------------
async function selectLog(id) {
  state.selectedId = id;
  renderRows();
  els.logView.innerHTML = '<span class="empty"><span class="spinner"></span> Loading log…</span>';
  hideAnalysis();
  try {
    const res = await fetch(`/api/logbody?org=${encodeURIComponent(state.org)}&id=${id}`);
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    state.logBody = await res.text();
    els.logSearch.disabled = false;
    els.analyzeBtn.disabled = false;
    els.analyzeQuestion.disabled = false;
    // If a content search is active, prefill the in-log search to jump to hits.
    els.logSearch.value = state.contentQuery || "";
    els.matchInfo.textContent = "";
    renderLog();
  } catch (e) {
    els.logView.innerHTML = `<span class="empty">Failed to load log: ${escapeHtml(e.message)}</span>`;
  }
}

function renderLog() {
  const q = els.logSearch.value.trim();
  const body = state.logBody;
  if (!q) {
    els.logView.textContent = body;
    state.matches = []; state.matchIndex = -1;
    return updateMatchInfo();
  }
  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  let html = "", last = 0, count = 0, m;
  while ((m = re.exec(body)) !== null) {
    html += escapeHtml(body.slice(last, m.index));
    html += `<mark data-i="${count}">${escapeHtml(m[0])}</mark>`;
    last = m.index + m[0].length; count++;
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  html += escapeHtml(body.slice(last));
  els.logView.innerHTML = html;
  state.matches = [...els.logView.querySelectorAll("mark")];
  state.matchIndex = state.matches.length ? 0 : -1;
  focusMatch();
  updateMatchInfo();
}
function updateMatchInfo() {
  const n = state.matches.length;
  els.matchInfo.textContent = n ? `${state.matchIndex + 1} / ${n}` : els.logSearch.value ? "0 matches" : "";
  els.prevMatch.disabled = n === 0;
  els.nextMatch.disabled = n === 0;
}
function focusMatch() {
  state.matches.forEach((el) => el.classList.remove("active"));
  const el = state.matches[state.matchIndex];
  if (el) { el.classList.add("active"); el.scrollIntoView({ block: "center", behavior: "smooth" }); }
}
function stepMatch(dir) {
  if (!state.matches.length) return;
  state.matchIndex = (state.matchIndex + dir + state.matches.length) % state.matches.length;
  focusMatch(); updateMatchInfo();
}

// --- analysis -------------------------------------------------------------
function hideAnalysis() { els.analysisPanel.classList.add("hidden"); }
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
async function runAnalysis() {
  els.analysisPanel.classList.remove("hidden");
  els.analysisContent.innerHTML = '<p><span class="spinner"></span> Analyzing with Claude…</p>';
  els.analyzeBtn.disabled = true;
  try {
    const { text } = await api("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ org: state.org, id: state.selectedId, question: els.analyzeQuestion.value.trim() }),
    });
    els.analysisContent.innerHTML = markdownToHtml(text);
  } catch (e) {
    els.analysisContent.innerHTML = `<p style="color:var(--red)">${escapeHtml(e.message)}</p>`;
    if (/api key/i.test(e.message)) openSettings();
  } finally {
    els.analyzeBtn.disabled = false;
  }
}

// --- settings -------------------------------------------------------------
async function openSettings() {
  try {
    const s = await api("/api/settings");
    els.modelSelect.value = s.model;
    els.apiKeyInput.value = "";
    els.keyHint.textContent = s.keyFromEnv
      ? "Using the ANTHROPIC_API_KEY environment variable for analysis."
      : s.hasKey
        ? "An API key is saved and used for analysis. Clear it to fall back to the local Claude Code CLI."
        : "No API key needed — analysis uses your local Claude Code CLI (claude) by default. Optionally paste an Anthropic API key to use the API instead.";
  } catch {}
  els.settingsModal.classList.remove("hidden");
}

function bind() {
  els.refreshBtn.addEventListener("click", () => refreshLogs());
  els.autoBtn.addEventListener("click", () => setAuto(!state.auto));
  els.orgSelect.addEventListener("change", () => { state.org = els.orgSelect.value; state.loggingReady = false; startCapture(); });
  els.listFilter.addEventListener("input", applyFilter);
  els.contentSearch.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); runContentSearch(); } });
  els.contentSearch.addEventListener("search", () => { if (!els.contentSearch.value) clearContentSearch(); });
  els.contentClear.addEventListener("click", clearContentSearch);
  els.logSearch.addEventListener("input", renderLog);
  els.logSearch.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); stepMatch(e.shiftKey ? -1 : 1); } });
  els.prevMatch.addEventListener("click", () => stepMatch(-1));
  els.nextMatch.addEventListener("click", () => stepMatch(1));
  els.analyzeBtn.addEventListener("click", runAnalysis);
  els.analyzeQuestion.addEventListener("keydown", (e) => { if (e.key === "Enter") runAnalysis(); });
  els.closeAnalysis.addEventListener("click", hideAnalysis);
  els.settingsBtn.addEventListener("click", openSettings);
  els.cancelSettings.addEventListener("click", () => els.settingsModal.classList.add("hidden"));
  els.saveSettings.addEventListener("click", async () => {
    const payload = { model: els.modelSelect.value };
    if (els.apiKeyInput.value.trim()) payload.apiKey = els.apiKeyInput.value.trim();
    await api("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    els.settingsModal.classList.add("hidden");
    status("Settings saved.", "success");
    setTimeout(clearStatus, 2000);
  });
}

async function init() {
  bind();
  await loadOrgs();
  if (els.orgSelect.value) await startCapture();
  // Keep the org list fresh (e.g. after logging into a new org in Chrome).
  setInterval(loadOrgs, 15000);
}
init();
