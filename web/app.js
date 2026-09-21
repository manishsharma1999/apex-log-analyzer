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
  windowMin: 2,      // only fetch org logs from the last N minutes (0/empty = all)
  fetched: false,    // has the user fetched logs for the current org yet?
  pollTimer: null,
  logsSig: "",             // signature of the last-rendered org log set (skip no-op re-renders)
  orgsSig: "",             // signature of the last-rendered org dropdown (skip no-op rebuilds)
  checked: new Set(),      // ids ticked for "analyze selected together"
  query: "",               // the single search box
  flashMatch: false,       // scroll to + flash the first match when the next raw render lands (set on log click)
  activeHit: null,         // { id, line } — the specific search-result preview row the user last clicked
  contentMatches: null,    // Map(id -> {snippet,count}) for text-in-body hits
  bodies: new Map(),       // id -> { text, lc } — in-memory full-text index (bodies are immutable, so safe to keep)
  searchSeq: 0,
  prefetchSeq: 0,          // cancels a stale background body-prefetch when the log set changes
  analysisAbort: null,     // AbortController for the in-flight Claude request
  analysisCtx: null,       // { logText, history:[{role,text}] } for follow-up chat
  viewMode: "raw",         // raw|profile|flame|queries|issues|vars
  lastProfile: null,       // last computed profile (for "✨ Explain")
  compareMode: false,      // in the ⇄ Compare two-group picker
  groupA: null,            // ids chosen for Group A while comparing
  model: null,             // structured model (ALA.buildModel) for the open log
  modelForId: null,        // which id state.model was built from (cache key)
  rawFilter: new Set(),    // active event categories in the noise filter (empty = all)
  collapseDupes: false,    // collapse consecutive identical lines in raw view
  flame: null,             // { root, range:[lo,hi] } current flame-graph view
  varPick: null,           // variable name selected in the Vars view
  sfEnabled: null,         // Set of MCP keys enabled for the Salesforce search (persists across opens)
  orgBlocked: {},          // apiHost -> reason for orgs whose session is valid but the API is refused (e.g. IP restriction)
};
const POLL_MS = 5000;
const MULTI_BUDGET = 150000; // total chars sent for multi-log analysis
let uploadSeq = 0;
let searchTimer = null;
let flameResizeTimer = null;
let viewerRepaintTimer = null;  // debounce the heavy raw-view repaint while typing
let silentPollFailures = 0;     // consecutive silent auto-refresh failures (stop after a few)
let indexedBytes = 0;           // total bytes held in the in-memory body index
let logbodyAbort = null;        // AbortController for the in-flight viewer log-body fetch
let rowCap = 0;                 // how many list rows are currently materialized (0 = default cap)
// Ids whose list row has already played its drop-in animation. The list fully
// rebuilds on every render (incl. each auto-refresh poll), so this is what keeps
// existing rows from re-animating — only genuinely new logs drop in. Cleared on
// resetView so a freshly loaded org cascades in again.
const seenRowIds = new Set();
// Ids captured in the most recent batch that brought new logs — these get the
// small "NEW" badge. When a later poll brings a fresh batch, this is replaced so
// the badge moves off the older logs and onto only the newly captured ones.
// Empty polls leave it untouched, so "NEW" persists until the next real batch.
let newRowIds = new Set();
// The first load after selecting/switching an org is a baseline — the logs that
// already existed aren't "new" to the user, so they don't get badged. Only logs
// that show up on a later refresh do. Reset on resetView.
let baselineLoaded = false;
// High-water mark: the newest StartTime (ms) we've already shown. A later log
// only counts as "newly captured" if it's at or past this — that's what stops
// an old log surfaced by "Fetch all" from being mistaken for a new arrival.
let seenMaxTime = 0;
// A log only counts as "NEW" if it was created within this window — so an old
// log surfacing (e.g. via Fetch all) never gets flagged as newly captured.
const NEW_BADGE_MS = 30 * 60 * 1000;

const $ = (id) => document.getElementById(id);
const els = {};
[
  "orgSelect", "autoBtn", "uploadBtn", "fileInput", "onSaveBtn", "sfBtn", "traceBtn", "modelSelect", "currentUser", "toastWrap",
  "search", "windowMin", "windowUnit", "fetchBtn", "fetchAllBtn", "deleteLogsBtn", "searchInfo", "logCount", "logRows", "listEmpty", "listPane", "dropHint",
  "selectAll", "bulkBar", "selCount", "analyzeSelected", "downloadSelected", "compareBtn", "codeHealthBtn", "matchInfo",
  "compareBar", "compareStep", "compareCancel", "compareNext", "compareRun",
  "viewRaw", "viewProfile", "viewFlame", "viewQueries", "viewIssues", "viewVars",
  "relatedBtn", "diagnoseBtn", "exportBtn", "explainProfile", "logView",
  "facetBar", "collapseDupes", "facetClear",
  "resizeMain", "resizeAnalysis", "layout", "searchRow", "viewerPane",
  "modelPick", "fetchLabel", "ctlSep", "logHead",
  "controlsRow", "emptyHero", "heroActions", "heroOrgSlot", "heroUploadSlot", "brand",
  "analysisPanel", "analysisTitle", "analysisContent", "closeAnalysis", "exportAnalysis", "chatInput", "chatSend",
].forEach((id) => (els[id] = $(id)));

// Trash/delete glyph, shared by the per-row icon and the toolbar Delete button
// so they're always the same symbol. Inherits color via currentColor.
const DEL_SVG = '<svg class="dl-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>';

// Cap on how much text we highlight in the viewer. Beyond this we still show
// the whole log (as fast plain text) but skip per-match DOM so huge logs
// (100k+ lines) never freeze the tab.
const MAX_HIGHLIGHT_CHARS = 600000;
const MAX_MARKS = 4000;

// Background full-text prefetch: warm the in-memory index so search stays
// instant, but don't eagerly drag hundreds of MB out of a large org.
const PREFETCH_CONCURRENCY = 6;
const PREFETCH_MAX_BYTES = 40 * 1024 * 1024;
// Max clickable preview rows to show per log (a log can have hundreds of hits);
// the rest are reachable via the "+N more — open log" row.
const HIT_CHIP_CAP = 12;
// Cap how many list rows we build in one render — a huge org (or a broad match)
// shouldn't materialize thousands of <tr> at once. Beyond this a "Show N more"
// row raises the cap and re-renders on demand.
const ROW_RENDER_CAP = 300;
// Above this many indexed bytes, coalesce the as-you-type raw-viewer repaint so a
// large open log doesn't get re-highlighted on every keystroke.
const BIG_INDEX_BYTES = 4 * 1024 * 1024;

// --- helpers --------------------------------------------------------------
// All app notices are floating toasts in the top-center strip (the old blue
// status bar's slot). Two flavours share the look:
//   • status()  — the single, in-place "current activity" line. It updates one
//     reusable toast (progress → outcome replaces cleanly, no stacking), exactly
//     like the old status bar did. Info/progress persists until replaced/cleared;
//     an outcome (success/warn/error) fades on its own.
//   • toast()   — a discrete, stacking event notice (log deleted, logs captured,
//     org connected, …) that auto-dismisses.
const TOAST_ICON = { success: "✓", error: "⚠", warn: "⚠", info: "ℹ" };
const TOAST_TTL = (kind) => (kind === "error" ? 6000 : kind === "info" ? 5000 : 3600);
function buildToast(message, kind, title) {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.innerHTML = `
    <span class="toast-ico">${TOAST_ICON[kind] || TOAST_ICON.info}</span>
    <span class="toast-body">${title ? `<span class="toast-title"></span>` : ""}<span class="toast-msg"></span></span>
    <button class="toast-close" title="Dismiss" aria-label="Dismiss">×</button>`;
  if (title) el.querySelector(".toast-title").textContent = title;
  el.querySelector(".toast-msg").textContent = message;
  return el;
}
function dismissToast(el) {
  if (!el || el.dataset.leaving) return;
  el.dataset.leaving = "1";
  clearTimeout(el._timer);
  el.classList.add("leaving");
  el.addEventListener("animationend", () => el.remove(), { once: true });
  setTimeout(() => el.remove(), 400); // fallback if animationend doesn't fire
}
// Center the toast stack in the blank band between the header's bottom line and
// the first visible content row, so it has an equal gap above and below (not
// stuck to the top). Measured live — survives the banner wrapping, the search
// row appearing, window resizes, etc. — instead of a brittle hardcoded pixel.
function centerToastBand() {
  if (!els.toastWrap) return;
  // Sit in the header row (logo / Org / Set Debug Log … Order of Execution),
  // centered on that row's own vertical middle so the toast floats in its empty
  // center — vertically in line with those controls, not in the row below.
  const topbar = document.querySelector(".topbar");
  if (!topbar) return;
  const r = topbar.getBoundingClientRect();
  els.toastWrap.style.top = `${Math.round((r.top + r.bottom) / 2)}px`;
}
window.addEventListener("resize", centerToastBand);
function toast(message, kind = "info", title = "") {
  if (!els.toastWrap || !message) return;
  centerToastBand();
  const el = buildToast(message, kind, title);
  el.querySelector(".toast-close").addEventListener("click", () => dismissToast(el));
  els.toastWrap.appendChild(el);
  el._timer = setTimeout(() => dismissToast(el), TOAST_TTL(kind));
  // Keep the stack short — but never evict the persistent status line.
  const evictable = [...els.toastWrap.children].filter((c) => !c.classList.contains("toast-status") && !c.dataset.leaving);
  while (evictable.length > 4) dismissToast(evictable.shift());
}
let statusToast = null;
function status(msg, kind = "info") {
  if (!msg) return clearStatus();
  if (!els.toastWrap) return;
  centerToastBand();
  if (!statusToast || !statusToast.isConnected || statusToast.dataset.leaving) {
    statusToast = buildToast(msg, kind, "");
    statusToast.classList.add("toast-status");
    statusToast.querySelector(".toast-close").addEventListener("click", clearStatus);
    els.toastWrap.appendChild(statusToast);
  } else {
    statusToast.className = `toast toast-status ${kind}`;
    statusToast.querySelector(".toast-ico").textContent = TOAST_ICON[kind] || TOAST_ICON.info;
    statusToast.querySelector(".toast-msg").textContent = msg;
  }
  clearTimeout(statusToast._timer);
  // Progress/info stays put until something replaces or clears it; an outcome fades.
  if (kind !== "info") statusToast._timer = setTimeout(clearStatus, TOAST_TTL(kind));
}
function clearStatus() {
  if (statusToast) { dismissToast(statusToast); statusToast = null; }
}
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
  return b.toLocaleString();
}
function rescape(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function truncate(s, n) { s = String(s); return s.length > n ? s.slice(0, n) + "…" : s; }
// Escape a log line for HTML, then wrap occurrences of the search term in <mark>.
function highlightText(text, q) {
  const esc = escapeHtml(text || "");
  if (!q) return esc;
  return esc.replace(new RegExp(rescape(escapeHtml(q)), "gi"), (m) => `<mark>${m}</mark>`);
}
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
async function loadOrgs({ fresh = false } = {}) {
  try {
    // `fresh` (a user Refresh / tab focus) forces a live server-side re-check so
    // a just logged-in org appears — and a just logged-OUT one disappears — at
    // once, instead of within the cache/poll window.
    const { orgs = [] } = await api(`/api/orgs${fresh ? "?fresh=1" : ""}`);
    // Only touch the DOM when the set of live orgs actually changed. Rebuilding
    // the <select> on every poll flickered it (and could close it mid-choice);
    // this also lets us detect the moment a newly logged-in org first appears.
    const sig = orgs.map((o) => `${o.value} ${o.label} ${o.blocked ? "!" + (o.reason || "") : ""}`).join("|") || "none";
    if (sig === state.orgsSig) return;
    // Remember which orgs are logged-in-but-unusable (valid session, API refused —
    // e.g. an IP restriction), keyed by apiHost, so the change handler can surface
    // the exact Salesforce reason when one is picked.
    state.orgBlocked = {};
    for (const o of orgs) if (o.blocked) state.orgBlocked[o.value] = o.reason || "This org can't be used from here.";
    const prev = els.orgSelect.value;
    // The org we were viewing is gone (logged out / session expired).
    const prevGone = !!prev && !orgs.some((o) => o.value === prev);
    state.orgsSig = sig;
    els.orgSelect.innerHTML = "";
    // Always start with an unselected placeholder — the user picks the org
    // deliberately, so we never act on an org they didn't choose.
    const ph = document.createElement("option");
    ph.value = ""; ph.textContent = orgs.length ? "Select an org…" : "No Salesforce session found in Chrome";
    els.orgSelect.appendChild(ph);
    if (!orgs.length) {
      state.org = "";
      loadWhoami(); // clears the top-right user chip (no active session)
      if (prevGone) { stopPolling(); resetView(); status("Logged out of the org — no active Salesforce session in Chrome.", "info"); }
      return;
    }
    for (const o of orgs) {
      const opt = document.createElement("option");
      opt.value = o.value;
      opt.textContent = o.label; // org domain only — no Chrome profile suffix
      els.orgSelect.appendChild(opt);
    }
    // Keep a still-valid prior selection; otherwise fall back to the placeholder.
    els.orgSelect.value = prev && !prevGone ? prev : "";
    state.org = els.orgSelect.value;
    // If the org we were viewing logged out, drop back to "no org" cleanly.
    if (prevGone) { stopPolling(); resetView(); loadWhoami(); }
  } catch (e) {
    status(e.message, "error");
  }
}

// Show which Salesforce user this tool is acting as (from the Chrome session),
// so the operator can always confirm the identity in the top-right corner.
let whoamiSeq = 0;
let lastWhoamiKey = null; // org::user we last announced, so we toast a login once
async function loadWhoami() {
  const org = els.orgSelect.value;
  const seq = ++whoamiSeq;
  if (!org) { els.currentUser.classList.add("hidden"); els.currentUser.innerHTML = ""; lastWhoamiKey = null; return; }
  try {
    const info = await api(`/api/whoami?org=${encodeURIComponent(org)}`);
    if (seq !== whoamiSeq) return; // a newer org selection won the race
    const name = info.name || info.username || "Unknown user";
    const uname = info.username && info.username !== name ? info.username : "";
    const copyTarget = info.username || name;
    const copyIcon =
      `<button type="button" class="cu-copy" title="Copy username" aria-label="Copy username">` +
      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
      `<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>`;
    els.currentUser.innerHTML =
      `👤 <span class="cu-label">Logged in as:</span> <span class="cu-name">${escapeHtml(name)}</span>` +
      (uname ? ` <span class="cu-username">(${escapeHtml(uname)})</span>` : "") +
      copyIcon;
    els.currentUser.title = `Signed in as ${name}${uname ? " (" + uname + ")" : ""} — ${org}`;
    const copyBtn = els.currentUser.querySelector(".cu-copy");
    if (copyBtn) copyBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(copyTarget);
        copyBtn.classList.add("copied");
        copyBtn.title = "Copied!";
        setTimeout(() => { copyBtn.classList.remove("copied"); copyBtn.title = "Copy username"; }, 1300);
      } catch { status("Couldn't copy — clipboard blocked by the browser.", "error"); }
    });
    els.currentUser.classList.remove("hidden");
    // Announce the connected identity once per org/user — not on every poll or
    // re-render. Switching org or user re-announces; a plain refresh doesn't.
    const idKey = `${org}::${info.username || name}`;
    if (idKey !== lastWhoamiKey) {
      toast(`${name}${uname ? ` (${uname})` : ""}`, "success", "Connected to org");
      lastWhoamiKey = idKey;
    }
  } catch {
    if (seq !== whoamiSeq) return;
    els.currentUser.classList.add("hidden");
    els.currentUser.innerHTML = "";
    lastWhoamiKey = null;
  }
}

// --- log list -------------------------------------------------------------
// `silent`  = background poll: no progress line, no outcome toast (only a
//             discrete "N new logs captured" toast when fresh logs arrive).
// `announce` = user clicked Fetch logs / Fetch all: report the outcome once
//             (N loaded / no new logs / no logs yet) as an auto-dismissing toast.
async function refreshLogs({ silent, announce } = {}) {
  const org = els.orgSelect.value;
  if (!org) { applyFilter(); return; }
  state.org = org;
  try {
    if (!silent) status("Loading logs…", "info");
    const mins = Number(state.windowMin) > 0 ? Number(state.windowMin) : 0;
    const { records = [] } = await api(`/api/logs?org=${encodeURIComponent(org)}${mins ? `&mins=${mins}` : ""}`);
    // The org picker may have moved while we awaited — don't clobber the new org's
    // view (or its polling) with this stale response.
    if (els.orgSelect.value !== org) return;
    silentPollFailures = 0; // a successful poll clears the failure streak
    // Keep the debug-log indicator honest while polling — refresh it at most
    // once a minute so it flips back to red when the trace flag expires.
    if (Date.now() - lastTraceCheck > 60000) refreshTraceStatus();
    // Merge, don't replace. A log already captured into the list must never
    // disappear just because it aged out of the "last N minutes" window on a
    // later poll (or a narrower fetch). Union by Id — a newer record wins, so a
    // log's finalized Status/Duration updates in place — then sort newest first.
    // Which fetched records are genuinely NEW to the list (not already shown)?
    // This is the accurate count to report on an explicit fetch — it counts
    // everything added, including older logs surfaced by "Fetch all", unlike
    // `arrived` (which is only the fresh-within-window auto-capture set).
    const hadIds = new Set(state.logs.map((r) => r.Id));
    const addedCount = records.reduce((n, r) => n + (r.Id && !hadIds.has(r.Id) ? 1 : 0), 0);
    const byId = new Map(state.logs.map((r) => [r.Id, r]));
    for (const r of records) byId.set(r.Id, r);
    const merged = [...byId.values()].sort((a, b) => {
      const ta = a.StartTime || "", tb = b.StartTime || "";
      if (ta !== tb) return ta < tb ? 1 : -1;      // StartTime descending
      return (a.Id || "") < (b.Id || "") ? 1 : -1; // stable tie-break
    });
    const sig = merged.map((r) => r.Id).join(",");
    // A silent poll with an unchanged log set must not re-render or re-search —
    // that full rebuild is what made the list (and search results) blink in a loop.
    if (silent && sig === state.logsSig) return;
    state.logsSig = sig;
    // Flag the "NEW" batch. A log counts as newly captured only if it is
    // genuinely NEWER than everything we've already shown — not merely absent
    // from the list. That distinction is what makes every scenario behave:
    //   • Auto-refresh: a just-created log has StartTime > seenMaxTime → NEW;
    //     the next batch ADDS to the NEW set — it does not displace the prior
    //     ones. Async / same-transaction logs land one at a time, so the earlier
    //     rows must keep their badge while the related ones keep arriving.
    //   • Fetch logs (last N min): the recent logs it returns are newer than the
    //     seen max → NEW.
    //   • Fetch all: it surfaces OLD logs too, but those are older than seenMaxTime
    //     so they are NOT flagged — only any genuinely newer ones are.
    // The first load per org is a silent baseline (pre-existing logs aren't new).
    // NEW markers accumulate and are aged out purely by the 30-min window (the
    // render guard drops each badge once its log passes NEW_BADGE_MS), so nothing
    // is un-badged just because a newer sibling showed up.
    const cutoff = Date.now() - NEW_BADGE_MS;
    const arrived = records.filter((r) => {
      if (!r.Id || !r.StartTime || seenRowIds.has(r.Id)) return false;
      const t = new Date(r.StartTime).getTime();
      return t >= seenMaxTime && t >= cutoff;
    });
    if (!baselineLoaded) {
      baselineLoaded = true; // establish the baseline without badging anything
    } else {
      for (const r of arrived) newRowIds.add(r.Id); // union — keep prior NEW rows
      // Background auto-refresh announces fresh arrivals here; an explicit fetch
      // reports its own outcome below (see `announce`), so don't double-toast.
      if (silent && arrived.length) toast(`${arrived.length} new log${arrived.length === 1 ? "" : "s"} captured`, "info");
    }
    // Advance the high-water mark past everything in this response (baseline
    // included) so the next refresh measures "newer than this".
    for (const r of records) {
      const t = r.StartTime ? new Date(r.StartTime).getTime() : 0;
      if (t > seenMaxTime) seenMaxTime = t;
    }
    state.logs = merged;
    applyFilter();
    prefetchBodies();                    // warm the in-memory index in the background
    if (state.query.trim()) searchInstant(); // refresh content hits for new logs
    if (!silent) clearStatus(); // drop the "Loading logs…" progress line
    if (announce) {
      // Report against the whole displayed list — merged org logs + uploads —
      // NOT this single fetch's raw batch. A narrow "Fetch logs (last 2 min)"
      // can return 0 records while 30 logs are on screen; that is "no new logs",
      // never "no logs yet". All three outcomes auto-dismiss.
      const total = state.logs.length + state.uploads.length;
      if (total === 0) toast("No logs yet. Perform actions in the org — new logs appear automatically.", "info");
      else if (addedCount > 0) toast(`${addedCount} new log${addedCount === 1 ? "" : "s"} loaded`, "success");
      else toast("No new logs", "info");
    }
  } catch (e) {
    // A one-off blip during background polling (dropped Wi-Fi, a transient 5xx)
    // shouldn't silently kill auto-refresh; only give up after a few in a row.
    // A user-initiated load surfaces the error and stops immediately.
    if (!silent) { status(e.message, "error"); stopPolling(); }
    else if (++silentPollFailures >= 3) { status(`Auto-refresh paused after repeated errors: ${e.message}`, "error"); stopPolling(); }
  }
}

// --- auto-capture ---------------------------------------------------------
// "Auto-capture" just auto-refreshes the list so new logs the org generates
// appear on their own — it only READS logs, it never enables debug logging.
// Enabling logging (creating a TraceFlag) happens ONLY when the user clicks
// "Start debug logging" (openTraceFlag) and confirms a duration — never here,
// and never automatically.
function startPolling() {
  stopPolling();
  if (!state.auto) return;
  silentPollFailures = 0; // fresh start — clear any prior failure streak
  els.autoBtn.classList.add("pulse");
  state.pollTimer = setInterval(() => refreshLogs({ silent: true }), POLL_MS);
}
function stopPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
  els.autoBtn.classList.remove("pulse");
}

async function startCapture({ announce = false } = {}) {
  const org = els.orgSelect.value;
  if (!org) return;
  state.org = org;
  loadWhoami(); // show which SF user this session belongs to (fire-and-forget)
  refreshTraceStatus(); // paint the red/green debug-log indicator (read-only)
  await refreshLogs({ announce });
  startPolling();
}

// Fetch buttons: "Fetch logs" uses the time window (last N minutes); "Fetch all"
// ignores it and pulls every log. Either way we need an org chosen first.
function fetchLogsClicked({ all = false } = {}) {
  if (!els.orgSelect.value) { status("Select an org first, then click Fetch.", "error"); return; }
  if (all) {
    state.windowMin = 0; // 0 = no time filter
  } else {
    const v = parseInt(els.windowMin.value, 10);
    const unit = els.windowUnit ? els.windowUnit.value : "min";
    const mult = unit === "day" ? 1440 : unit === "hour" ? 60 : 1;
    state.windowMin = Number.isFinite(v) && v > 0 ? v * mult : 0;
  }
  state.fetched = true;
  startCapture({ announce: true }); // user asked — report the outcome as a toast
}

function setAuto(on) {
  state.auto = on;
  els.autoBtn.textContent = on ? "● Auto-refresh: ON" : "○ Auto-refresh: OFF";
  els.autoBtn.className = on ? "on" : "off";
  if (on) startCapture();
  else stopPolling();
}

// --- search (one box: metadata + full text, across org logs & uploads) ----
// Search is instant: every log body we fetch is indexed into state.bodies
// (lowercased once) and grepped in memory on each keystroke — no network, no
// debounce. Bodies we don't hold yet are warmed by prefetchBodies() in the
// background and, until then, covered by a short-debounced server-side grep.
let reindexTimer = null;

// Stash a body (org log or upload) in the in-memory index, lowercased once so
// repeat searches are just String.indexOf. Bodies are immutable — safe to keep.
function indexBody(id, text) {
  if (id == null || text == null || state.bodies.has(id)) return;
  state.bodies.set(id, { text, lc: text.toLowerCase() });
  indexedBytes += text.length;
}
function makeSnippet(body, idx, len) {
  const start = Math.max(0, idx - 40);
  const end = Math.min(body.length, idx + len + 60);
  return (start > 0 ? "…" : "") + body.slice(start, end).replace(/\s+/g, " ").trim() + (end < body.length ? "…" : "");
}
// Find every occurrence of `needle` in one body, single-pass: total count plus,
// for the first `cap` hits, the 1-based line number (matches the viewer gutter)
// and that line's text (for the hover tooltip). O(body length) — `scan` only
// ever moves forward.
function matchHits(rawText, lcText, needle, cap) {
  const hits = [];
  let from = 0, scan = 0, line = 1, count = 0, idx, lastLine = -1;
  while ((idx = lcText.indexOf(needle, from)) !== -1) {
    count++;
    // One preview row per matching LINE, not per occurrence: multiple hits on the
    // same line (e.g. "10" in "10:10:34.1 …[100]") would otherwise render as
    // identical rows that all jump to the same line and highlight together.
    if (hits.length < cap) {
      while (scan < idx) { if (rawText.charCodeAt(scan) === 10) line++; scan++; }
      if (line !== lastLine) {
        let ls = idx; while (ls > 0 && rawText.charCodeAt(ls - 1) !== 10) ls--;
        let le = idx; while (le < rawText.length && rawText.charCodeAt(le) !== 10) le++;
        hits.push({ line, text: rawText.slice(ls, le).trim() });
        lastLine = line;
      }
    }
    from = idx + needle.length;
  }
  return { hits, count };
}
// Grep everything we already hold in memory. Pure + synchronous — the fast path.
function clientMatches(q) {
  const lc = q.toLowerCase();
  const m = new Map();
  for (const [id, e] of state.bodies) {
    if (!e.lc.includes(lc)) continue;
    const { hits, count } = matchHits(e.text, e.lc, lc, HIT_CHIP_CAP);
    m.set(id, { hits, count, line: hits[0] ? hits[0].line : 1, snippet: makeSnippet(e.text, e.lc.indexOf(lc), q.length) });
  }
  return m;
}
// The as-you-type entry point: filter + highlight instantly from memory, then
// (only if some listed org bodies aren't indexed yet) fill the gap via the server.
function searchInstant() {
  clearTimeout(searchTimer);
  const q = state.query.trim();
  const seq = ++state.searchSeq;   // invalidate any in-flight server search
  if (!q) {
    state.contentMatches = null;
    els.searchInfo.textContent = "";
    applyFilter();
    if (state.viewMode === "raw") renderLog();
    return;
  }
  state.contentMatches = clientMatches(q);
  applyFilter();
  scheduleViewerRepaint(); // keep the open log's highlighting in sync (coalesced for big logs)
  const missing = els.orgSelect.value && state.logs.some((l) => !state.bodies.has(l.Id));
  const n = state.filtered.length;
  els.searchInfo.textContent = `${n} match${n === 1 ? "" : "es"}${missing ? " · indexing…" : ""}`;
  if (missing) searchTimer = setTimeout(() => serverSearch(seq, q), 150);
}
// Fallback for logs whose bodies we haven't fetched yet — the server greps them
// (its bodies are cached too), and we merge those hits into the live results.
async function serverSearch(seq, q) {
  try {
    const { matches = [] } = await api(`/api/search?org=${encodeURIComponent(els.orgSelect.value)}&q=${encodeURIComponent(q)}`);
    if (seq !== state.searchSeq) return; // a newer keystroke superseded this
    const m = state.contentMatches || new Map();
    for (const mt of matches) if (!m.has(mt.id)) m.set(mt.id, mt);
    state.contentMatches = m;
    applyFilter();
    scheduleViewerRepaint();
    els.searchInfo.textContent = `${state.filtered.length} match${state.filtered.length === 1 ? "" : "es"}`;
  } catch (e) {
    if (seq === state.searchSeq) els.searchInfo.textContent = `${state.filtered.length} match${state.filtered.length === 1 ? "" : "es"}`;
  }
}
// Coalesced re-search while the background prefetch is streaming bodies in, so
// "indexing…" results fill in on their own without hammering the DOM.
function reindexLive() {
  if (!state.query.trim() || reindexTimer) return;
  reindexTimer = setTimeout(() => { reindexTimer = null; if (state.query.trim()) searchInstant(); }, 120);
}
// Re-highlight the open raw log to match the current query. On a large indexed
// corpus (a big open log) re-marking on every keystroke stutters, so coalesce it;
// small logs still repaint immediately so highlighting feels instant.
function scheduleViewerRepaint() {
  if (state.viewMode !== "raw") return;
  clearTimeout(viewerRepaintTimer);
  if (indexedBytes <= BIG_INDEX_BYTES) { renderLog(); return; }
  viewerRepaintTimer = setTimeout(() => { if (state.viewMode === "raw") renderLog(); }, 120);
}
// Warm the in-memory index in the background so search stays instant. Fetches
// org-log bodies we don't hold yet, newest first, at bounded concurrency and
// under a byte budget so a huge org can't pull hundreds of MB.
async function prefetchBodies() {
  const org = els.orgSelect.value;
  if (!org) return;
  const seq = ++state.prefetchSeq;
  const todo = state.logs.filter((l) => l.Id && !state.bodies.has(l.Id));
  if (!todo.length) return;
  let budget = PREFETCH_MAX_BYTES, i = 0;
  const worker = async () => {
    while (i < todo.length && budget > 0) {
      const l = todo[i++];
      if (seq !== state.prefetchSeq) return;        // a newer log set superseded us
      if (state.bodies.has(l.Id)) continue;
      if (Number(l.LogLength) > budget) continue;    // would blow the budget — leave it to server search
      try {
        const res = await fetch(`/api/logbody?org=${encodeURIComponent(org)}&id=${encodeURIComponent(l.Id)}`);
        if (!res.ok) continue;
        const text = await res.text();
        if (seq !== state.prefetchSeq) return;
        indexBody(l.Id, text);
        budget -= text.length;
        reindexLive();                                // let live results fill in as bodies land
      } catch { /* ignore — server search covers it */ }
    }
  };
  await Promise.all(Array.from({ length: PREFETCH_CONCURRENCY }, worker));
}

function applyFilter() {
  const q = state.query.trim().toLowerCase();
  const items = allItems();
  state.filtered = !q ? items : items.filter((it) => {
    const meta = [it.user, it.operation, it.status, it.id].filter(Boolean).join(" ").toLowerCase();
    if (meta.includes(q)) return true;
    return state.contentMatches ? state.contentMatches.has(it.id) : false;
  });
  rowCap = 0; // a changed result set collapses back to the first page of rows
  renderRows();
}

// --- Cold-start → workspace transition -------------------------------------
// When the welcome hero gives way to the working layout we run a FLIP: the
// brand logo + title fly up from the hero into the top-left header, the org
// picker + upload button (the very same DOM nodes) glide to their toolbar
// homes, and the workspace rises into view. Purely cosmetic — if anything
// can't be measured, or the user prefers reduced motion, we just skip it.
const prefersReducedMotion =
  window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
let heroWasShown = null; // tracks the previous cold-start state to detect the leave

function rectOf(el) {
  return el && el.isConnected ? el.getBoundingClientRect() : null;
}

// Snapshot the FIRST (hero) positions of everything that has a destination.
function captureHeroFlip() {
  const hero = els.emptyHero;
  const orgPick = els.orgSelect ? els.orgSelect.closest(".org-pick") : null;
  return {
    logo: rectOf(hero && hero.querySelector(".hero-logo")),
    title: rectOf(hero && hero.querySelector(".hero-title")),
    org: rectOf(orgPick),
    upload: rectOf(els.uploadBtn),
  };
}

// Given an element in its final (LAST) spot and where it started (FIRST rect),
// invert it back to the start then release — the browser tweens the transform.
function flyFrom(el, first, { scale = false } = {}) {
  if (!el || !first) return;
  const last = el.getBoundingClientRect();
  if (!last.width || !last.height) return;
  const dx = first.left - last.left;
  const dy = first.top - last.top;
  const s = scale ? first.width / last.width : 1;
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(s - 1) < 0.01) return;
  el.classList.add("flip-fly");
  // Invert: instantly place the element back at its FIRST position. The
  // transition MUST be off for this step, and inline styles beat any stylesheet
  // rule (e.g. .brand .app-logo's own transform transition), so set both inline.
  el.style.transition = "none";
  el.style.transformOrigin = "top left";
  el.style.transform = `translate(${dx}px, ${dy}px) scale(${s})`;
  // Two frames so the inverted transform is committed with no transition before
  // we turn the transition on and release to the natural position.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      el.style.transition = "transform 640ms cubic-bezier(0.22, 1, 0.36, 1)";
      el.style.transform = "translate(0px, 0px) scale(1)";
    })
  );
  const done = (e) => {
    if (e && e.propertyName && e.propertyName !== "transform") return;
    el.classList.remove("flip-fly");
    el.style.transition = "";
    el.style.transform = "";
    el.style.transformOrigin = "";
    el.style.willChange = "";
    el.removeEventListener("transitionend", done);
  };
  el.addEventListener("transitionend", done);
  setTimeout(done, 780); // fallback if transitionend never fires
}

// Replay a slide-up reveal on a workspace chunk that's newly on screen.
function oneShotReveal(el) {
  if (!el) return;
  el.classList.remove("reveal-up");
  void el.offsetWidth; // reflow so the animation restarts even if it lingered
  el.classList.add("reveal-up");
  const done = () => {
    el.classList.remove("reveal-up");
    el.removeEventListener("animationend", done);
  };
  el.addEventListener("animationend", done);
}

function playHeroFlip(first) {
  const brandLogo = els.brand ? els.brand.querySelector(".app-logo") : null;
  const brandTitle = els.brand ? els.brand.querySelector("span") : null;
  const orgPick = els.orgSelect ? els.orgSelect.closest(".org-pick") : null;
  flyFrom(brandLogo, first.logo, { scale: true });
  flyFrom(brandTitle, first.title, { scale: true });
  flyFrom(orgPick, first.org);
  flyFrom(els.uploadBtn, first.upload);
  // The workspace behind the flight rises into view.
  oneShotReveal(els.searchRow);
  oneShotReveal(els.controlsRow);
  oneShotReveal(els.listPane ? els.listPane.querySelector(".table-wrap") : null);
  if (els.viewerPane && !els.viewerPane.classList.contains("hidden")) {
    oneShotReveal(els.viewerPane);
  }
}

// Progressive disclosure: keep the initial screen to just the fetch controls.
// The search box appears once there are logs to search; the whole viewer pane
// (and its divider) appears only once a log is actually opened — until then the
// list takes the full width. Org-level / log-level actions reveal in step.
function updateChrome() {
  const hasLogs = (state.uploads.length + state.logs.length) > 0;
  const hasOpen = state.selectedId != null;
  const hasOrg = !!(els.orgSelect && els.orgSelect.value);
  // Detect the cold-start → workspace leave and snapshot hero positions *before*
  // the DOM mutations below move the shared nodes and hide the hero.
  const showHeroNow = !hasOrg && !hasLogs;
  const leavingHero = heroWasShown === true && !showHeroNow && !prefersReducedMotion;
  const flipFirst = leavingHero ? captureHeroFlip() : null;
  // Cold start — no org picked and nothing loaded — shows a centered welcome hero
  // instead of a barren toolbar. The org picker + upload button physically move
  // into the hero (no duplicate controls), then back to the toolbar once you're
  // working. Picking an org or loading a log dismisses the hero.
  placeEntryControls(!hasOrg && !hasLogs);
  if (els.searchRow) els.searchRow.classList.toggle("hidden", !hasLogs);
  if (els.viewerPane) els.viewerPane.classList.toggle("hidden", !hasOpen);
  if (els.resizeMain) els.resizeMain.classList.toggle("hidden", !hasOpen);
  if (els.layout) els.layout.classList.toggle("solo", !hasOpen);
  if (els.sfBtn) els.sfBtn.classList.toggle("hidden", !hasLogs);       // searches prior art on selected logs' errors
  if (els.onSaveBtn) els.onSaveBtn.classList.toggle("hidden", !hasOrg); // order-of-execution needs an org
  if (els.traceBtn) els.traceBtn.classList.toggle("hidden", !hasOrg);   // trace flag targets the org's current user
  // Fetch / auto-refresh only make sense against a chosen org; until then the
  // only useful control is "Upload .log" (which works with no org). Uploading a
  // .log still counts as hasLogs, so the model picker + table header appear then.
  if (els.fetchLabel) els.fetchLabel.classList.toggle("hidden", !hasOrg);
  if (els.fetchBtn) els.fetchBtn.classList.toggle("hidden", !hasOrg);
  if (els.fetchAllBtn) els.fetchAllBtn.classList.toggle("hidden", !hasOrg);
  // Delete sits with the fetch controls; it's useful wherever there are logs to
  // act on (org logs or uploaded files). Its label/disabled state is driven by
  // the current selection in updateBulkBar().
  if (els.deleteLogsBtn) els.deleteLogsBtn.classList.toggle("hidden", !(hasOrg || hasLogs));
  if (els.ctlSep) els.ctlSep.classList.toggle("hidden", !hasOrg);
  if (els.autoBtn) els.autoBtn.classList.toggle("hidden", !hasOrg);
  // Model picker is irrelevant until there's a log to analyze; table header is
  // noise on an empty list (the "No logs yet" hint says everything).
  if (els.modelPick) els.modelPick.classList.toggle("hidden", !hasLogs);
  if (els.logHead) els.logHead.classList.toggle("hidden", !hasLogs);
  // The welcome hero replaces the whole toolbar + "No logs yet" line at cold start.
  const showHero = !hasOrg && !hasLogs;
  if (els.emptyHero) els.emptyHero.classList.toggle("hidden", !showHero);
  if (els.brand) els.brand.classList.toggle("hidden", showHero); // logo+title live in the hero at cold start
  if (els.controlsRow) els.controlsRow.classList.toggle("hidden", showHero);
  if (els.listEmpty) els.listEmpty.classList.toggle("hidden", showHero || state.filtered.length > 0);
  // Now that the DOM sits in its final layout, play the FLIP from the snapshot.
  heroWasShown = showHero;
  if (leavingHero) playHeroFlip(flipFirst);
}

// Cold start moves the org picker + upload button into the centered hero card;
// once you're working they slide back to their normal toolbar homes. We relocate
// the live DOM nodes (rather than cloning) so their state + listeners stay intact.
let heroHomes = null;
function placeEntryControls(inHero) {
  const orgPick = els.orgSelect ? els.orgSelect.closest(".org-pick") : null;
  const uploadBtn = els.uploadBtn;
  if (!orgPick || !uploadBtn || !els.heroOrgSlot || !els.heroUploadSlot) return;
  if (!heroHomes) heroHomes = {
    org: { parent: orgPick.parentNode, next: orgPick.nextSibling },
    upload: { parent: uploadBtn.parentNode, next: uploadBtn.nextSibling },
  };
  const orgHome = inHero ? els.heroOrgSlot : heroHomes.org.parent;
  const uploadHome = inHero ? els.heroUploadSlot : heroHomes.upload.parent;
  if (orgPick.parentNode !== orgHome) {
    if (inHero) els.heroOrgSlot.appendChild(orgPick);
    else heroHomes.org.parent.insertBefore(orgPick, heroHomes.org.next);
  }
  if (uploadBtn.parentNode !== uploadHome) {
    if (inHero) els.heroUploadSlot.appendChild(uploadBtn);
    else heroHomes.upload.parent.insertBefore(uploadBtn, heroHomes.upload.next);
  }
}

function renderRows() {
  els.logRows.innerHTML = "";
  const total = state.uploads.length + state.logs.length;
  els.logCount.textContent = `${state.filtered.length} / ${total}`;
  els.listEmpty.classList.toggle("hidden", state.filtered.length > 0);
  updateChrome();
  const q = state.query.trim();
  // Materialize at most `cap` tiles per render — a huge org (or a broad match)
  // would otherwise build thousands of <tr> and stall the tab. A trailing
  // "Show N more" row raises the cap on demand.
  const cap = rowCap > 0 ? rowCap : ROW_RENDER_CAP;
  const shown = Math.min(state.filtered.length, cap);
  let rowNum = 0;
  let newRowIdx = 0; // staggers the cascade across rows that are new this render
  const animateRows = !prefersReducedMotion;
  for (let i = 0; i < shown; i++) {
    const it = state.filtered[i];
    rowNum++;
    const match = state.contentMatches && state.contentMatches.get(it.id);
    const hits = match && match.hits && match.hits.length ? match.hits
      : (match && match.line ? [{ line: match.line, text: match.snippet || "" }] : []);
    const hasHits = hits.length > 0;
    const open = it.id === state.selectedId; // the log currently shown in the viewer

    const tr = document.createElement("tr");
    // Open log's whole tile gets a subtle "tile-open" highlight; a hitless open
    // log (plain browse) keeps the stronger "selected" rail on its single row.
    tr.className = "tile-main" + (hasHits ? " has-hits" + (open ? " tile-open" : "") : " clickable" + (open ? " selected" : ""));
    const checked = state.checked.has(it.id) ? "checked" : "";
    const pill = it.kind === "upload" ? "up" : (it.ok ? "ok" : "err");
    // Badge only genuinely-new rows, and only while the log is still within the
    // 30-min freshness window. The badge sits inline just after the timestamp
    // (in the existing gap before the User column) so the row number stays put.
    const isNew = newRowIds.has(it.id) && it.time && (Date.now() - new Date(it.time).getTime()) <= NEW_BADGE_MS;
    if (isNew) tr.classList.add("is-new");
    const newBadge = isNew ? `<span class="new-badge">NEW</span>` : "";
    tr.innerHTML = `
      <td class="rownum">${rowNum}</td>
      <td class="chk"><input type="checkbox" ${checked} /></td>
      <td class="time-cell">${it.kind === "upload" ? "📄 " : ""}${fmtTime(it.time)}${newBadge}</td>
      <td class="usr">${escapeHtml(it.user)}</td>
      <td class="op">${escapeHtml(it.operation)}</td>
      <td><span class="status-pill ${pill}">${escapeHtml(it.status)}</span></td>
      <td class="dur">${it.duration != null ? it.duration.toLocaleString() : ""}</td>
      <td class="size">${fmtSize(it.size)}</td>
      <td class="dl"><button class="icon-btn dl-btn" title="Download this log as .log"><svg class="dl-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="8 17 12 21 16 17"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.88 18.09A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.29"/></svg></button><button class="icon-btn del-btn" title="${it.kind === "upload" ? "Remove this file from the list" : "Delete this log from the org"}">${DEL_SVG}</button></td>`;
    // The debug-log label row opens the log only when there are no search-result
    // preview rows below it; during search you navigate via the preview rows.
    if (!hasHits) {
      tr.addEventListener("click", (e) => { if (!e.target.closest(".chk") && !e.target.closest(".dl")) selectLog(it.id); });
    }
    const cb = tr.querySelector(".chk input");
    cb.addEventListener("click", (e) => e.stopPropagation());
    cb.addEventListener("change", (e) => toggleCheck(it.id, e.target.checked));
    const dl = tr.querySelector(".dl .dl-btn");
    dl.addEventListener("click", (e) => { e.stopPropagation(); downloadLog(it.id); });
    const del = tr.querySelector(".dl .del-btn");
    del.addEventListener("click", (e) => { e.stopPropagation(); deleteItems([it.id]); });
    // Drop-in animation: only for rows we haven't shown before (first load, or a
    // new log arriving via auto-refresh). Seen rows render instantly so the list
    // doesn't flicker on every poll. Stagger is capped so a big first batch
    // cascades quickly rather than trickling in for seconds.
    if (animateRows && !seenRowIds.has(it.id)) {
      tr.classList.add("row-in");
      tr.style.animationDelay = Math.min(newRowIdx, 14) * 28 + "ms";
      newRowIdx++;
      tr.addEventListener("animationend", function onEnd() {
        tr.classList.remove("row-in");
        tr.style.animationDelay = "";
        tr.removeEventListener("animationend", onEnd);
      });
    }
    seenRowIds.add(it.id);
    els.logRows.appendChild(tr);

    if (hasHits) {
      const rows = []; // track rows in this tile so the last one gets the divider
      const head = document.createElement("tr");
      head.className = "preview-head" + (open ? " tile-open" : "");
      head.innerHTML = `<td colspan="9"><span class="hit-count">${match.count || hits.length} hit${(match.count || hits.length) === 1 ? "" : "s"}</span></td>`;
      els.logRows.appendChild(head); rows.push(head);

      // Each occurrence is its own full-width, clickable preview row: line number
      // + the matched line's text (term highlighted). Clicking opens + jumps to it,
      // and that exact row becomes the highlighted (active) one.
      hits.forEach((h) => {
        const pr = document.createElement("tr");
        const isActive = state.activeHit && state.activeHit.id === it.id && state.activeHit.line === h.line;
        pr.className = "preview-row" + (open ? " tile-open" : "") + (isActive ? " pv-active" : "");
        const td = document.createElement("td");
        td.colSpan = 9;
        td.innerHTML = `<div class="pv-inner"><span class="pv-line">line ${h.line}</span><span class="pv-text">${highlightText(h.text, q)}</span></div>`;
        pr.appendChild(td);
        pr.addEventListener("click", () => {
          state.activeHit = { id: it.id, line: h.line };
          els.logRows.querySelectorAll(".preview-row.pv-active").forEach((r) => r.classList.remove("pv-active"));
          pr.classList.add("pv-active");
          void pr.offsetWidth;                            // flush the highlight to paint now...
          requestAnimationFrame(() => jumpToHit(it.id, h.line)); // ...before the heavy re-render, so it shows on click (not on next hover)
        });
        els.logRows.appendChild(pr); rows.push(pr);
      });

      if (match.count && match.count > hits.length) {
        const mr = document.createElement("tr");
        mr.className = "preview-row more" + (open ? " tile-open" : "");
        mr.innerHTML = `<td colspan="9"><div class="pv-inner"><span class="pv-more">+${match.count - hits.length} more — open log</span></div></td>`;
        mr.addEventListener("click", () => selectLog(it.id));
        els.logRows.appendChild(mr); rows.push(mr);
      }
      rows[rows.length - 1].classList.add("tile-end");
    }
  }
  // "Show N more" — raise the cap by a page and re-render. Only appears when the
  // result set outgrows the current cap.
  const remaining = state.filtered.length - shown;
  if (remaining > 0) {
    const more = document.createElement("tr");
    more.className = "clickable show-more";
    more.innerHTML = `<td colspan="9"><div class="pv-inner"><span class="pv-more">Show ${remaining.toLocaleString()} more…</span></div></td>`;
    more.addEventListener("click", () => { rowCap = shown + ROW_RENDER_CAP; renderRows(); });
    els.logRows.appendChild(more);
  }
  syncSelectAll();
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
  // Delete button (toolbar, next to Fetch all): label mirrors the current target —
  // the ticked set, or the single open log. Disabled (but visible) when nothing's
  // targeted, so it's discoverable without being a live hazard.
  if (els.deleteLogsBtn) {
    els.deleteLogsBtn.disabled = target === 0 || busy;
    const label = target === 0 ? "Delete"
      : n >= 2 ? `Delete ${n} selected logs`
      : "Delete selected log";
    // Same trash glyph as the per-row icon (inline SVG), not the emoji.
    els.deleteLogsBtn.innerHTML = `${DEL_SVG}<span>${label}</span>`;
  }
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
  // Assign ids up front in pick order so "open the last file" is deterministic —
  // it must not depend on which read happens to finish last.
  const entries = files.map((f) => ({ f, id: `upload:${++uploadSeq}`, ok: false }));
  const lastPickedId = entries[entries.length - 1].id;
  let pending = entries.length, failed = 0;
  const finish = () => {
    if (--pending !== 0) return;
    applyFilter();
    if (state.query.trim()) searchInstant();
    // Prefer the last file the user picked; fall back to any that read cleanly.
    const openId = entries.some((e) => e.ok && e.id === lastPickedId)
      ? lastPickedId
      : (entries.find((e) => e.ok) || {}).id;
    if (openId) selectLog(openId);
    const ok = entries.length - failed;
    if (failed) status(`Added ${ok} file${ok === 1 ? "" : "s"}; ${failed} could not be read.`, ok ? "warn" : "error");
    else status(`Added ${ok} file${ok === 1 ? "" : "s"}.`, "success");
    setTimeout(clearStatus, failed ? 4000 : 2000);
  };
  for (const e of entries) {
    const reader = new FileReader();
    reader.onload = () => {
      const body = String(reader.result || "");
      state.uploads.unshift({ id: e.id, name: e.f.name, body, size: e.f.size, when: new Date().toISOString() });
      indexBody(e.id, body); // instantly searchable
      e.ok = true;
      finish();
    };
    reader.onerror = () => { failed++; finish(); };
    reader.readAsText(e.f);
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

// --- delete ---------------------------------------------------------------
// A small confirm modal, styled like the other popups. Resolves true/false.
function confirmDialog({ title, message, confirmLabel = "Delete", danger = true }) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal";
    overlay.innerHTML = `
      <div class="modal-card">
        <h2>${escapeHtml(title)}</h2>
        <p class="hint">${escapeHtml(message)}</p>
        <div class="modal-actions">
          <button id="cfCancel">Cancel</button>
          <button id="cfGo" class="${danger ? "danger" : "primary"}">${escapeHtml(confirmLabel)}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const done = (v) => { document.removeEventListener("keydown", onKey); overlay.remove(); resolve(v); };
    const onKey = (e) => { if (e.key === "Escape") done(false); };
    document.addEventListener("keydown", onKey);
    overlay.querySelector("#cfCancel").addEventListener("click", () => done(false));
    overlay.querySelector("#cfGo").addEventListener("click", () => done(true));
    overlay.addEventListener("click", (e) => { if (e.target === overlay) done(false); });
    overlay.querySelector("#cfGo").focus();
  });
}

// Delete a set of items. Org logs (07L…) are permanently deleted from Salesforce
// via the API; uploaded files are only removed from this in-memory list (they
// were never in the org). Always confirms first, since org deletion can't be undone.
async function deleteItems(ids) {
  const uniq = [...new Set((ids || []).filter(Boolean))];
  if (!uniq.length) return;
  const orgIds = uniq.filter((id) => !findUpload(id));
  const upIds = uniq.filter((id) => findUpload(id));
  const total = uniq.length;

  let title, message, confirmLabel;
  if (orgIds.length) {
    title = "Delete logs from the org?";
    message = `This permanently deletes ${orgIds.length} log${orgIds.length === 1 ? "" : "s"} from the org via the Salesforce API — this can't be undone.`
      + (upIds.length ? ` ${upIds.length} uploaded file${upIds.length === 1 ? "" : "s"} will also be removed from this list.` : "");
    confirmLabel = total === 1 ? "Delete log" : `Delete ${total} logs`;
  } else {
    title = "Remove uploaded file" + (upIds.length === 1 ? "?" : "s?");
    message = `Remove ${upIds.length} uploaded file${upIds.length === 1 ? "" : "s"} from the list? They aren't stored in the org, so this only clears them here.`;
    confirmLabel = upIds.length === 1 ? "Remove file" : `Remove ${upIds.length} files`;
  }
  if (!(await confirmDialog({ title, message, confirmLabel }))) return;

  // Uploaded files: drop from the local list immediately (nothing to call).
  if (upIds.length) state.uploads = state.uploads.filter((u) => !upIds.includes(u.id));

  let serverErr = null, deletedOrg = 0;
  if (orgIds.length) {
    status(`Deleting ${orgIds.length} log${orgIds.length === 1 ? "" : "s"} from the org…`, "info");
    try {
      const { deleted = 0, errors = [] } = await api("/api/logs", {
        method: "DELETE", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ org: state.org, ids: orgIds }),
      });
      deletedOrg = deleted;
      const failedIds = new Set(errors.map((e) => e.id));
      // Drop only the rows the org confirmed gone; anything that errored stays.
      state.logs = state.logs.filter((l) => !(orgIds.includes(l.Id) && !failedIds.has(l.Id)));
      if (errors.length) serverErr = `${errors.length} log${errors.length === 1 ? "" : "s"} could not be deleted: ${errors[0].message}`;
    } catch (e) {
      serverErr = e.message;
    }
  }

  // Clear selection + close the viewer for anything that's now gone.
  const stillExists = (id) => !!findUpload(id) || state.logs.some((l) => l.Id === id);
  for (const id of uniq) if (!stillExists(id)) state.checked.delete(id);
  if (state.selectedId != null && !stillExists(state.selectedId)) {
    state.selectedId = null;
    state.logBody = "";
    state.model = null;
    state.modelForId = null;
  }
  applyFilter();
  updateBulkBar();

  if (serverErr) { status(`Delete failed: ${serverErr}`, "error"); return; }
  const parts = [];
  if (deletedOrg) parts.push(`Deleted ${deletedOrg} log${deletedOrg === 1 ? "" : "s"} from the org`);
  if (upIds.length) parts.push(`removed ${upIds.length} file${upIds.length === 1 ? "" : "s"}`);
  status(parts.join(", ") + ".", "success");
}

// Clear everything tied to the previously-selected org (kept: uploaded files,
// which are org-independent). Used when switching orgs so no stale log/analysis
// lingers even if the new org fails to load.
function resetView() {
  state.logs = [];
  state.logsSig = "";
  seenRowIds.clear(); // let the next org's logs cascade in fresh
  newRowIds = new Set(); // drop any "NEW" markers from the previous org
  baselineLoaded = false; // next org's first load is a baseline, not "new"
  seenMaxTime = 0; // reset the high-water mark for the next org
  state.selectedId = null;
  state.logBody = "";
  state.checked.clear();
  state.contentMatches = null;
  state.prefetchSeq++; // cancel any in-flight background prefetch for the old org
  // Drop the old org's indexed bodies (keep uploads, which the user still sees).
  for (const id of [...state.bodies.keys()]) if (!String(id).startsWith("upload:")) state.bodies.delete(id);
  // Recompute the index-size accumulator from what's left so the viewer-repaint
  // gate doesn't stay inflated by the dropped org's bodies.
  indexedBytes = 0;
  for (const e of state.bodies.values()) indexedBytes += e.text.length;
  state.lastProfile = null;
  state.model = null;
  state.modelForId = null;
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
  // Clicking a search hit should always land you on the match — even when this
  // log is already open (re-click) or you'd scrolled away — by flashing +
  // scrolling to it once the raw view renders (only when a search is active).
  state.flashMatch = !!state.query.trim();
  renderRows();
  updateBulkBar();  // surface "Analyze this log" for the just-opened log
  // Fast path: anything we've already indexed (uploads, prefetched or
  // previously-opened logs) renders straight from memory — no network, no
  // "Loading…" flicker — so re-clicking a result scrolls instantly.
  const up = findUpload(id);
  const cached = up ? up.body : (state.bodies.has(id) ? state.bodies.get(id).text : null);
  if (cached != null) {
    state.logBody = cached;
    indexBody(id, cached);
    renderCurrentView();
    return;
  }
  els.logView.innerHTML = '<span class="empty"><span class="spinner"></span> Loading log…</span>';
  // Abort any still-in-flight body fetch for a log the user has since clicked away
  // from, so its (now stale, possibly larger/slower) response can't land after this
  // one and leave the viewer showing the wrong log.
  if (logbodyAbort) logbodyAbort.abort();
  logbodyAbort = new AbortController();
  const signal = logbodyAbort.signal;
  try {
    const res = await fetch(`/api/logbody?org=${encodeURIComponent(state.org)}&id=${id}`, { signal });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    if (state.selectedId !== id) return; // a newer click superseded this load
    state.logBody = await res.text();
    indexBody(id, state.logBody);
    renderCurrentView();
  } catch (e) {
    if (e.name === "AbortError") return; // superseded by a newer selection — leave its view alone
    els.logView.innerHTML = `<span class="empty">Failed to load log: ${escapeHtml(e.message)}</span>`;
  }
}

// Click a line pill on the left → open that log (from cache, instant) and
// scroll + flash the exact occurrence, not just the first match.
async function jumpToHit(id, line) {
  if (state.selectedId !== id) await selectLog(id);
  jumpToLine(line - 1); // jumpToLine takes a 0-based line index
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

// Category of a raw line, for the noise filter (matches ALA.categoryOf).
function lineCategory(line) {
  const i = line.indexOf("|");
  if (i < 0) return "other";
  const j = line.indexOf("|", i + 1);
  const ev = j < 0 ? line.slice(i + 1) : line.slice(i + 1, j);
  return window.ALA.categoryOf(ev);
}
// Build the list of lines to show, honouring the noise filter + collapse-repeats.
// Each entry keeps its real index so line numbers stay absolute after filtering.
function visibleLines(body) {
  const lines = body.split("\n");
  const filter = state.rawFilter;
  const filtering = filter.size > 0;
  const out = [];
  let prev = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (filtering && !filter.has(lineCategory(line))) continue;
    if (state.collapseDupes && line === prev && line.trim() !== "") {
      const last = out[out.length - 1];
      if (last) last.dup = (last.dup || 1) + 1;
      continue;
    }
    out.push({ idx: i, line });
    prev = line;
  }
  return out;
}
function renderLog() {
  const q = state.query.trim();
  const body = state.logBody;
  if (body == null) return;
  const flash = state.flashMatch;   // consume once — set only when a search hit was clicked
  state.flashMatch = false;
  const filtering = state.rawFilter.size > 0 || state.collapseDupes;
  // Very large logs: fast plain text (no gutter/colours) so the tab never freezes.
  if (body.length > MAX_HIGHLIGHT_CHARS) {
    els.logView.className = "log-view plain";
    els.logView.textContent = filtering ? visibleLines(body).map((e) => e.line).join("\n") : body;
    els.matchInfo.textContent = q ? "large log — highlighting off (⌘F to find)" : (filtering ? "filtered" : "");
    return;
  }
  const re = q ? new RegExp(rescape(q), "gi") : null;
  const counter = { n: 0, capped: false };
  const entries = visibleLines(body);
  const out = ['<div class="code-lines">'];
  for (const e of entries) {
    let h = "";
    for (const seg of tokenizeApex(e.line)) {
      const inner = markSegment(seg.text, re, counter);
      h += seg.cls ? `<span class="${seg.cls}">${inner}</span>` : inner;
    }
    const dup = e.dup ? `<span class="dup-badge">×${e.dup}</span>` : "";
    out.push(`<div class="cline" data-ln="${e.idx + 1}">${h || "&nbsp;"}${dup}</div>`);
  }
  out.push("</div>");
  els.logView.className = "log-view code";
  els.logView.innerHTML = out.join("");
  els.matchInfo.textContent = !q
    ? (filtering ? `${entries.length} line(s) shown` : "")
    : counter.n
      ? `${counter.n}${counter.capped ? "+" : ""} match${counter.n === 1 ? "" : "es"} in this log`
      : "0 in this log";
  // Scroll to the first match. On a fresh log click (flashMatch) also flash the
  // whole line once so the eye lands on it; on plain re-renders (typing in the
  // search box) just keep it in view without the distracting flash.
  if (q && counter.n) {
    requestAnimationFrame(() => {
      const first = els.logView.querySelector("mark");
      if (!first) return;
      first.scrollIntoView({ block: "center", behavior: flash ? "smooth" : "auto" });
      if (!flash) return;
      const line = first.closest(".cline");
      if (line) {
        line.classList.remove("line-flash");
        void line.offsetWidth;            // restart the CSS animation if it was mid-flight
        line.classList.add("line-flash");
        setTimeout(() => line.classList.remove("line-flash"), 1600);
      }
    });
  }
}
// Sync the facet checkboxes to state (used after jump-to clears the filter).
function syncFacetUI() {
  els.facetBar.querySelectorAll("input[data-cat]").forEach((cb) => { cb.checked = state.rawFilter.has(cb.getAttribute("data-cat")); });
  if (els.collapseDupes) els.collapseDupes.checked = state.collapseDupes;
}

// --- structured model (the shared "spine" every advanced view reads) -------
// Built once per open log and cached; every view below reuses it instead of
// re-parsing, so switching views on a big log stays instant.
function currentModel() {
  if (state.modelForId === state.selectedId && state.model) return state.model;
  state.model = window.ALA.buildModel(state.logBody || "");
  state.modelForId = state.selectedId;
  return state.model;
}
const msNs = (ns) => (ns / 1e6).toFixed(1);

// Which toolbar actions apply to the open log.
function updateViewerButtons() {
  const hasLog = !!state.logBody;
  const isOrg = state.selectedId != null && !findUpload(state.selectedId);
  els.diagnoseBtn.classList.toggle("hidden", !hasLog);
  els.relatedBtn.classList.toggle("hidden", !hasLog || !isOrg);
  els.exportBtn.classList.toggle("hidden", !hasLog && !state.analysisCtx);
}

// --- performance profiler (⏱ Profile) -------------------------------------
const VIEW_SEGS = { raw: "viewRaw", profile: "viewProfile", flame: "viewFlame", queries: "viewQueries", issues: "viewIssues", vars: "viewVars" };
function setViewMode(mode) {
  state.viewMode = mode;
  for (const [m, id] of Object.entries(VIEW_SEGS)) els[id].classList.toggle("on", mode === m);
  renderCurrentView();
}
function renderCurrentView() {
  els.explainProfile.classList.toggle("hidden", state.viewMode !== "profile" || !state.logBody);
  // Show the noise-filter facet bar whenever we're in Raw view with a log open —
  // synced here (not just in setViewMode) so it also appears the moment a log is
  // first opened, not only after switching views.
  els.facetBar.classList.toggle("hidden", state.viewMode !== "raw" || !state.logBody);
  updateViewerButtons();
  switch (state.viewMode) {
    case "profile": return renderProfile();
    case "flame": return renderFlame();
    case "queries": return renderQueries();
    case "issues": return renderIssues();
    case "vars": return renderVars();
    default: return renderLog();
  }
}

function renderProfile() {
  els.logView.className = "log-view profile-view";
  if (!state.logBody) { els.logView.innerHTML = '<div class="empty">Select a log to profile it.</div>'; return; }
  const m = currentModel();
  const rows = m.slowest.slice(0, 20);
  // Keep a compatible object for the "✨ Explain" button (unchanged contract).
  state.lastProfile = { totalNs: m.totalNs, soql: m.soqlCount, dml: m.dmlCount, limits: m.limits, rows };
  let h = '<div class="profile"><h3>Overview</h3><table class="prof-table"><tbody>';
  h += `<tr><td>Wall time</td><td class="num">${msNs(m.totalNs)} ms</td></tr>`;
  h += `<tr><td>SOQL queries</td><td class="num">${m.soqlCount}</td></tr>`;
  h += `<tr><td>DML statements</td><td class="num">${m.dmlCount}</td></tr>`;
  if (m.calloutCount) h += `<tr><td>Callouts</td><td class="num">${m.calloutCount}</td></tr>`;
  h += "</tbody></table>";
  if (m.truncatedBySF) h += '<p class="hint warn">⚠ This log was truncated by Salesforce — some events are missing. Narrow your debug levels and re-capture.</p>';
  if (m.limits.length) {
    h += '<h3>Governor limits</h3><table class="prof-table"><thead><tr><th>Limit</th><th class="num">Used</th><th class="num">Max</th><th>%</th></tr></thead><tbody>';
    for (const l of m.limits) {
      const pct = l.max ? Math.round(100 * l.used / l.max) : 0;
      const cls = pct >= 90 ? "lim-hot" : pct >= 75 ? "lim-warn" : "lim-ok";
      h += `<tr class="${cls}"><td>${escapeHtml(l.label)}</td><td class="num">${l.used}</td><td class="num">${l.max}</td>` +
           `<td><span class="bar" style="width:${Math.min(100, Math.max(2, pct))}px"></span>${pct}%</td></tr>`;
    }
    h += "</tbody></table>";
  }
  if (rows.length) {
    h += '<h3>Slowest operations</h3><table class="prof-table"><thead><tr><th>Operation</th><th class="num">Total ms</th><th class="num">Self ms</th><th class="num">Calls</th></tr></thead><tbody>';
    for (const r of rows) {
      h += `<tr><td class="prof-name" title="${escapeHtml(r.name)}">${escapeHtml(r.name)}</td>` +
           `<td class="num">${msNs(r.total)}</td><td class="num">${msNs(r.self)}</td><td class="num">${r.count}</td></tr>`;
    }
    h += "</tbody></table>";
  } else {
    h += '<p class="hint">No METHOD_ENTRY/EXIT timing found — turn on Apex Code (FINE) + Profiling in your debug level to capture method timings.</p>';
  }
  els.logView.innerHTML = h + "</div>";
}

// --- #2 Flame graph (canvas — no DOM explosion on deep trees) --------------
const FLAME_ROW_H = 20;
const FLAME_COLORS = { method: "#4a9eff", soql: "#d29922", dml: "#e0743c", callout: "#56b6c2", flow: "#b083f0", error: "#f85149", other: "#7f8796" };
let flameHit = null; // { node, x, y, w } under the cursor, for tooltip + click

function flameRoot(m) {
  // A synthetic root spans the whole transaction and holds the real top frames.
  return { n: "(transaction)", k: "other", s: m.firstNs, e: m.lastNs, d: m.totalNs, self: 0, c: m.roots, li: -1 };
}
function renderFlame() {
  els.logView.className = "log-view flame-view";
  if (!state.logBody) { els.logView.innerHTML = '<div class="empty">Select a log to profile it.</div>'; return; }
  const m = currentModel();
  if (!m.roots.length || !m.totalNs) {
    els.logView.innerHTML = '<div class="empty">No method timing to graph.<br/><span class="hint">Enable Apex Code = FINE + Profiling in your debug level to capture the call tree.</span></div>';
    return;
  }
  const root = flameRoot(m);
  if (!state.flame || state.flame.forId !== state.selectedId) state.flame = { forId: state.selectedId, focus: root };
  const focus = state.flame.focus && rangeValid(state.flame.focus, root) ? state.flame.focus : root;
  state.flame.focus = focus;

  const wrap = document.createElement("div");
  wrap.className = "flame-wrap";
  const bar = document.createElement("div");
  bar.className = "flame-controls";
  bar.innerHTML = `<button class="mini" id="flameReset">⤺ Reset zoom</button>
    <span class="hint">${escapeHtml(focus.n === "(transaction)" ? "Full transaction" : truncate(focus.n, 80))} · ${msNs(focus.d)} ms — click a frame to zoom, click empty to zoom out</span>` +
    (m.treeCapped ? '<span class="hint warn">⚠ Call tree truncated — this graph shows only part of a very deep/large log.</span>' : '');
  const canvas = document.createElement("canvas");
  canvas.className = "flame-canvas";
  const tip = document.createElement("div");
  tip.className = "flame-tip hidden";
  wrap.appendChild(bar); wrap.appendChild(canvas); wrap.appendChild(tip);
  els.logView.innerHTML = "";
  els.logView.appendChild(wrap);

  const frames = [];               // flat list of drawn frames for hit-testing
  const lo = focus.s, span = focus.d || 1;
  let maxDepth = 0;

  function collect(node, depth) {
    if (depth > maxDepth) maxDepth = depth;
    for (const ch of node.c) {
      if (ch.s == null || ch.d <= 0) continue;
      const x = (ch.s - lo) / span;
      const w = ch.d / span;
      if (x > 1 || x + w < 0) continue;         // outside focus window
      if (w < 0.0008) continue;                 // sub-pixel — skip it and its subtree
      frames.push({ node: ch, depth, x, w });
      collect(ch, depth + 1);
    }
  }
  collect(focus, 0);

  const AXIS_H = 22;               // reserved strip at the top for the time ruler
  function draw() {
    const cssW = wrap.clientWidth - 2;
    const rows = maxDepth + 1;
    const cssH = Math.max(rows * FLAME_ROW_H + 4, 60) + AXIS_H;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = cssW * dpr; canvas.height = cssH * dpr;
    canvas.style.width = cssW + "px"; canvas.style.height = cssH + "px";
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.font = "11px ui-monospace, monospace";
    ctx.textBaseline = "middle";

    // --- Time ruler: 0 → focus duration across the width, with gridlines ---
    const cs = getComputedStyle(document.documentElement);
    const cMuted = (cs.getPropertyValue("--muted") || "#9aa3b2").trim();
    const cGrid = (cs.getPropertyValue("--border") || "#2a2f3a").trim();
    const spanMs = span / 1e6;
    const nTicks = Math.max(2, Math.min(10, Math.round(cssW / 120)));
    const dec = spanMs < 2 ? 3 : spanMs < 20 ? 2 : spanMs < 200 ? 1 : 0;
    for (let i = 0; i <= nTicks; i++) {
      const frac = i / nTicks;
      const gx = Math.round(frac * cssW) + 0.5;
      ctx.strokeStyle = cGrid; ctx.globalAlpha = 0.5;
      ctx.beginPath(); ctx.moveTo(gx, AXIS_H); ctx.lineTo(gx, cssH); ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = cMuted;
      ctx.textAlign = i === 0 ? "left" : i === nTicks ? "right" : "center";
      const lx = i === 0 ? 2 : i === nTicks ? cssW - 2 : frac * cssW;
      ctx.fillText((frac * spanMs).toFixed(dec) + (i === nTicks ? " ms" : ""), lx, AXIS_H / 2);
    }
    ctx.strokeStyle = cGrid; ctx.globalAlpha = 1;
    ctx.beginPath(); ctx.moveTo(0, AXIS_H + 0.5); ctx.lineTo(cssW, AXIS_H + 0.5); ctx.stroke();
    ctx.textAlign = "left";

    for (const f of frames) {
      const px = f.x * cssW, pw = Math.max(1, f.w * cssW), py = f.depth * FLAME_ROW_H + 2 + AXIS_H;
      f._px = px; f._py = py; f._pw = pw;
      ctx.fillStyle = FLAME_COLORS[f.node.k] || FLAME_COLORS.other;
      ctx.globalAlpha = f.node === (flameHit && flameHit.node) ? 1 : 0.86;
      ctx.fillRect(px, py, pw - 1, FLAME_ROW_H - 2);
      if (f.node === (flameHit && flameHit.node)) {
        ctx.globalAlpha = 1; ctx.strokeStyle = cMuted; ctx.lineWidth = 1;
        ctx.strokeRect(px + 0.5, py + 0.5, pw - 2, FLAME_ROW_H - 3);
      }
      ctx.globalAlpha = 1;
      if (pw > 34) {
        ctx.fillStyle = "#0c0e13";
        ctx.save(); ctx.beginPath(); ctx.rect(px + 3, py, pw - 6, FLAME_ROW_H - 2); ctx.clip();
        ctx.fillText(f.node.n, px + 4, py + (FLAME_ROW_H - 2) / 2);
        ctx.restore();
      }
    }
  }
  draw();

  canvas.addEventListener("mousemove", (e) => {
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    let hit = null;
    for (const f of frames) if (mx >= f._px && mx <= f._px + f._pw && my >= f._py && my <= f._py + FLAME_ROW_H - 2) { hit = f; break; }
    if ((hit && hit.node) !== (flameHit && flameHit.node)) { flameHit = hit; draw(); }
    if (hit) {
      tip.classList.remove("hidden");
      tip.innerHTML = `<b>${escapeHtml(hit.node.n)}</b><br/>${msNs(hit.node.d)} ms total · ${msNs(hit.node.self)} ms self${hit.node.ln ? " · " + escapeHtml(hit.node.ln) : ""}`;
      const tx = Math.min(mx + 12, wrap.clientWidth - 240);
      tip.style.left = Math.max(4, tx) + "px";
      tip.style.top = (my + 46) + "px";
    } else tip.classList.add("hidden");
  });
  canvas.addEventListener("mouseleave", () => { tip.classList.add("hidden"); if (flameHit) { flameHit = null; draw(); } });
  canvas.addEventListener("click", () => {
    if (flameHit) { state.flame.focus = flameHit.node; renderFlame(); }
    else if (focus !== root) { state.flame.focus = root; renderFlame(); }
  });
  canvas.addEventListener("dblclick", (e) => {
    // double-click a frame jumps to its line in the raw view
    if (flameHit && flameHit.node.li >= 0) jumpToLine(flameHit.node.li);
  });
  bar.querySelector("#flameReset").addEventListener("click", () => { state.flame.focus = root; renderFlame(); });
}
function rangeValid(node, root) {
  // Is `node` still a descendant of root (i.e. from the current model)?
  if (node === root) return true;
  const stack = [root];
  while (stack.length) { const n = stack.pop(); if (n === node) return true; for (const c of n.c) stack.push(c); }
  return false;
}

// --- #3 SOQL / DML inventory with N+1 detection ----------------------------
function renderQueries() {
  els.logView.className = "log-view table-view";
  if (!state.logBody) { els.logView.innerHTML = '<div class="empty">Select a log to inspect its queries.</div>'; return; }
  const m = currentModel();
  let h = '<div class="datatable">';
  if (!m.soql.length && !m.dml.length) {
    h += '<p class="hint">No SOQL or DML executed in this log.</p></div>';
    els.logView.innerHTML = h; return;
  }
  if (m.soql.length) {
    h += `<h3>SOQL — ${m.soqlCount} run(s), ${m.soql.length} distinct shape(s)</h3>`;
    h += '<table class="prof-table"><thead><tr><th class="num">Count</th><th class="num">Rows</th><th class="num">ms</th><th>Query</th></tr></thead><tbody>';
    for (const g of m.soql) {
      const hot = g.count >= 5;
      h += `<tr class="q-row${hot ? " q-hot" : ""}" data-line="${g.firstLine}" title="Click to jump to first run">` +
        `<td class="num">${g.count}${hot ? " ⚠" : ""}</td><td class="num">${g.rows}</td><td class="num">${msNs(g.ns)}</td>` +
        `<td class="q-text">${escapeHtml(g.sample)}</td></tr>`;
    }
    h += "</tbody></table>";
    if (m.soql.some((g) => g.count >= 5)) h += '<p class="hint warn">⚠ Rows flagged above ran 5+ times with the same shape — a classic query-in-a-loop / N+1. Bulkify or hoist out of the loop.</p>';
  }
  if (m.dml.length) {
    h += `<h3>DML — ${m.dmlCount} statement(s)</h3>`;
    h += '<table class="prof-table"><thead><tr><th class="num">Count</th><th>Operation</th><th>Object</th><th class="num">Rows</th><th class="num">ms</th></tr></thead><tbody>';
    for (const g of m.dml) {
      const hot = g.count >= 5;
      h += `<tr class="q-row${hot ? " q-hot" : ""}" data-line="${g.firstLine}">` +
        `<td class="num">${g.count}${hot ? " ⚠" : ""}</td><td>${escapeHtml(g.op)}</td><td>${escapeHtml(g.type || "—")}</td><td class="num">${g.rows}</td><td class="num">${msNs(g.ns)}</td></tr>`;
    }
    h += "</tbody></table>";
  }
  h += "</div>";
  els.logView.innerHTML = h;
  els.logView.querySelectorAll(".q-row").forEach((tr) => {
    tr.addEventListener("click", () => { const ln = +tr.getAttribute("data-line"); if (ln >= 0) jumpToLine(ln); });
  });
}

// --- #1 + #7 Issues: detectors + first-failure jump -----------------------
function renderIssues() {
  els.logView.className = "log-view issues-view";
  if (!state.logBody) { els.logView.innerHTML = '<div class="empty">Select a log to scan for issues.</div>'; return; }
  const m = currentModel();
  const issues = window.ALA.detectIssues(m);
  let h = '<div class="issues">';
  const firstFail = m.exceptions[0];
  h += '<div class="issues-actions">';
  if (firstFail) h += `<button class="mini danger" id="jumpFail">⚠ Jump to first failure (line ${firstFail.line + 1})</button>`;
  h += '<button class="mini primary" id="diagnoseFromIssues">🔍 Diagnose with Claude</button></div>';
  if (!issues.length) {
    h += '<p class="ok-note">✓ No deterministic issues detected — no near-limit governor usage, no repeated queries, no unhandled exceptions.</p>';
  } else {
    for (const f of issues) {
      const sev = f.severity.toLowerCase();
      h += `<div class="issue sev-${sev}${f.line != null ? " jumpable" : ""}"${f.line != null ? ` data-line="${f.line}"` : ""}>` +
        `<span class="sev-badge ${sev}">${f.severity}</span>` +
        `<div class="issue-body"><div class="issue-title">${escapeHtml(f.title)}</div>` +
        `<div class="issue-detail">${escapeHtml(f.detail)}</div></div>` +
        (f.line != null ? `<span class="issue-jump" title="Jump to line ${f.line + 1}">→ line ${f.line + 1}</span>` : "") +
        "</div>";
    }
  }
  h += "</div>";
  els.logView.innerHTML = h;
  const jf = $("jumpFail"); if (jf) jf.addEventListener("click", () => jumpToLine(firstFail.line));
  const dfi = $("diagnoseFromIssues"); if (dfi) dfi.addEventListener("click", runDiagnose);
  els.logView.querySelectorAll(".issue.jumpable").forEach((el) => {
    el.addEventListener("click", () => jumpToLine(+el.getAttribute("data-line")));
  });
}

// --- #10 Variable value tracking ------------------------------------------
function renderVars() {
  els.logView.className = "log-view vars-view";
  if (!state.logBody) { els.logView.innerHTML = '<div class="empty">Select a log to track variables.</div>'; return; }
  const m = currentModel();
  const names = [...m.vars.keys()].sort((a, b) => m.vars.get(b).length - m.vars.get(a).length);
  if (!names.length) {
    els.logView.innerHTML = '<div class="empty">No VARIABLE_ASSIGNMENT events.<br/><span class="hint">Set Apex Code = FINEST in your debug level to capture variable values.</span></div>';
    return;
  }
  if (!state.varPick || !m.vars.has(state.varPick)) state.varPick = names[0];
  let h = '<div class="vars"><div class="vars-list"><input id="varFilter" type="search" placeholder="Filter variables…" /><div class="vars-names">';
  for (const n of names) h += `<div class="var-name${n === state.varPick ? " on" : ""}" data-var="${escapeHtml(n)}">${escapeHtml(n)} <span class="var-count">${m.vars.get(n).length}</span></div>`;
  h += '</div></div><div class="vars-timeline">';
  const samples = m.vars.get(state.varPick) || [];
  h += `<h3>${escapeHtml(state.varPick)} — ${samples.length} assignment(s)</h3>`;
  h += '<table class="prof-table"><thead><tr><th>#</th><th>Line ref</th><th>Value</th></tr></thead><tbody>';
  const cap = Math.min(samples.length, 500);
  for (let i = 0; i < cap; i++) {
    const s = samples[i];
    h += `<tr class="var-row" data-line="${s.line}"><td class="num">${i + 1}</td><td>${escapeHtml(s.lineRef || "")}</td><td class="var-val">${escapeHtml(s.value || "")}</td></tr>`;
  }
  h += "</tbody></table>";
  if (samples.length > cap) h += `<p class="hint">Showing first ${cap} of ${samples.length}.</p>`;
  h += "</div></div>";
  els.logView.innerHTML = h;
  const filter = $("varFilter");
  filter.addEventListener("input", () => {
    const q = filter.value.toLowerCase();
    els.logView.querySelectorAll(".var-name").forEach((el) => {
      el.classList.toggle("hidden", !el.getAttribute("data-var").toLowerCase().includes(q));
    });
  });
  els.logView.querySelectorAll(".var-name").forEach((el) => {
    el.addEventListener("click", () => { state.varPick = el.getAttribute("data-var"); renderVars(); });
  });
  els.logView.querySelectorAll(".var-row").forEach((tr) => {
    tr.addEventListener("click", () => jumpToLine(+tr.getAttribute("data-line")));
  });
}

// Jump to a 0-based line index in the Raw view and flash-highlight it.
function jumpToLine(idx) {
  if (idx == null || idx < 0) return;
  state.rawFilter.clear();          // clear the noise filter + collapse so the target line is present
  state.collapseDupes = false;
  state.flashMatch = false;         // we flash THIS line below — suppress renderLog's first-match auto-flash
                                    // so two lines don't end up highlighted at once
  syncFacetUI();
  if (state.viewMode !== "raw") setViewMode("raw");
  else renderLog();
  requestAnimationFrame(() => {
    // Only ever one flashed line at a time — clear any left over from a prior jump.
    els.logView.querySelectorAll(".cline.line-flash").forEach((l) => l.classList.remove("line-flash"));
    const el = els.logView.querySelector(`.cline[data-ln="${idx + 1}"]`);
    if (el) {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      el.classList.remove("line-flash");
      void el.offsetWidth;               // force reflow so the flash animation paints immediately (not just on next hover)
      el.classList.add("line-flash");
      setTimeout(() => el.classList.remove("line-flash"), 1600);
    } else if (state.logBody) {
      // Plain (very large) view: scroll proportionally.
      const m = currentModel();
      els.logView.scrollTop = (idx / Math.max(1, m.lineCount)) * els.logView.scrollHeight;
    }
  });
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
  updateViewerButtons();
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
    updateViewerButtons();
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
// Build one structured model over the full bodies of a group of logs.
async function groupModel(ids, signal) {
  let body = "";
  for (const id of ids) {
    if (signal && signal.aborted) throw new DOMException("aborted", "AbortError");
    body += (body ? "\n" : "") + await getBody(id, signal);
  }
  return window.ALA.buildModel(body);
}
// #8 A deterministic A→B diff table (semantic, from the models — not text diff).
function diffMarkdown(diff) {
  let md = "## Deterministic diff (A → B)\n\n| Metric | A | B | Δ |\n| --- | ---: | ---: | ---: |\n";
  for (const r of diff.rows) {
    const arrow = r.worse ? " 🔺" : r.better ? " 🔻" : "";
    md += `| ${r.label} | ${r.a} | ${r.b} | ${r.delta > 0 ? "+" + r.delta : r.delta}${arrow} |\n`;
  }
  if (diff.queryChanges.length) {
    md += "\n**SOQL shape changes:**\n\n";
    for (const q of diff.queryChanges.slice(0, 20)) {
      const label = q.kind === "added" ? `➕ new (${q.count}×)` : q.kind === "removed" ? `➖ gone (was ${q.count}×)` : `✳ count ${q.from}→${q.count}`;
      md += `- ${label}: \`${q.sample.slice(0, 140)}\`\n`;
    }
  }
  return md;
}
function compareRun() {
  const b = [...state.checked];
  if (!b.length) { status("Tick at least one log for Group B.", "error"); return; }
  const a = state.groupA || [];
  exitCompareMode();
  return runPanel(`⇄ Compare — A(${a.length}) vs B(${b.length})`, async (signal) => {
    const ma = await groupModel(a, signal);
    const mb = await groupModel(b, signal);
    const diffMd = diffMarkdown(window.ALA.diffModels(ma, mb));
    const digestA = window.ALA.buildDigest(ma, "GROUP A");
    const digestB = window.ALA.buildDigest(mb, "GROUP B");
    const { text } = await api("/api/compare", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ digestA, digestB }), signal,
    });
    return { text: diffMd + "\n\n---\n\n" + text, chatLogText: `===== GROUP A DIGEST =====\n${digestA}\n\n===== GROUP B DIGEST =====\n${digestB}` };
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
    const { objects = [] } = await api(`/api/objects?org=${encodeURIComponent(state.org)}`);
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

// The "Set Debug Log" button carries a live indicator: red = no active trace
// flag on the session's user, green = one is active. This is read-only — it
// never creates anything.
function setTraceIndicator(active, expiration) {
  if (!els.traceBtn) return;
  els.traceBtn.classList.toggle("active", !!active);
  const until = active && expiration ? ` (until ${new Date(expiration).toLocaleTimeString()})` : "";
  els.traceBtn.title = active
    ? `Debug logging is ON for your user${until}. Click to extend or change the duration.`
    : "No active trace flag on your user — the org isn't writing your debug logs yet. Click to start debug logging (you choose how long).";
}
let lastTraceCheck = 0;
async function refreshTraceStatus() {
  const org = els.orgSelect.value;
  if (!org || !els.traceBtn) return;
  lastTraceCheck = Date.now();
  try {
    const r = await api(`/api/traceflag-status?org=${encodeURIComponent(org)}`);
    if (els.orgSelect.value !== org) return; // org changed mid-flight
    // Green ONLY when the session's own user has an active flag — other users'
    // flags show as chips inside the popup, not on the toolbar dot.
    setTraceIndicator(!!r.selfActive, r.expiration);
  } catch { /* transient — leave the current indicator as-is */ }
}

// Small trash/dustbin glyph for the "remove trace flag" chip buttons. Inline SVG
// (allowed by the CSP) so it inherits the chip's white color via currentColor.
const TRASH_SVG = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 21 6"></polyline><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"></path><path d="M6 6l1 14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-14"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>';

// Set a debug-log TraceFlag on a chosen user — strictly on demand. Opens a popup
// where the user searches the org (by name, username, or email) for whom to
// trace, picks a duration, and clicks Create; nothing is created until then.
// Every user with an active USER_DEBUG flag is listed as a chip with a × to
// remove it. The debug level (Apex = FINEST, Workflow = FINER) is fixed
// server-side to match the Setup UI.
function openTraceFlag() {
  if (!state.org) { status("Select a Salesforce org first.", "error"); return; }
  const overlay = document.createElement("div");
  overlay.className = "modal";
  overlay.innerHTML = `
    <div class="modal-card">
      <h2><svg class="h2-log" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path d="M13.5 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V8.5z"></path><path d="M13.5 3v5.5h5.5"></path><text x="12" y="17.6" font-size="5" font-weight="800" fill="currentColor" stroke="none" text-anchor="middle" letter-spacing="-0.3" font-family="Arial, Helvetica, sans-serif">LOG</text></svg> Start debug logging</h2>
      <p class="hint">Turns on debug logging for a Salesforce user — Apex Code = <strong>FINEST</strong>, Workflow = <strong>FINER</strong>. Search for any active user by name, username, or email, or leave it on yourself. Logs for a traced user capture here automatically.</p>
      <label class="lookup-label" for="traceUserSearch">Set debug logging for</label>
      <div class="user-lookup">
        <input id="traceUserSearch" type="text" autocomplete="off" spellcheck="false" placeholder="🔎 Search users by name, username, or email…" />
        <button type="button" id="traceUserClear" class="lookup-clear hidden" title="Clear and choose a different user" aria-label="Clear selected user">×</button>
        <div id="traceUserResults" class="lookup-results hidden"></div>
      </div>
      <div class="trace-duration">
        <input id="traceDur" type="number" min="1" step="1" value="30" inputmode="numeric" />
        <select id="traceUnit">
          <option value="min" selected>minutes</option>
          <option value="hour">hours</option>
        </select>
      </div>
      <p class="hint" id="traceNote">Salesforce caps a trace flag at 24 hours.</p>
      <div class="trace-chips-wrap">
        <span class="chips-label">Debug logging is active for:</span>
        <div id="traceChips" class="trace-chips"><span class="chips-empty">Loading…</span></div>
      </div>
      <div id="traceToast" class="trace-toast hidden" role="status" aria-live="polite"></div>
      <div class="modal-actions">
        <span class="spacer"></span>
        <button id="traceCancel">Close</button>
        <button id="traceGo" class="primary">Create</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const search = overlay.querySelector("#traceUserSearch");
  const clearBtn = overlay.querySelector("#traceUserClear");
  const results = overlay.querySelector("#traceUserResults");
  const dur = overlay.querySelector("#traceDur");
  const unit = overlay.querySelector("#traceUnit");
  const go = overlay.querySelector("#traceGo");
  const note = overlay.querySelector("#traceNote");
  const chips = overlay.querySelector("#traceChips");
  const toastEl = overlay.querySelector("#traceToast");
  const close = () => overlay.remove();

  // Show enable/delete outcomes inside this popup (not the main status bar) as
  // an icon + title + subtitle card.
  const TOAST_ICON = {
    success: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"></path></svg>`,
    error: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6L6 18"></path></svg>`,
    info: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8h.01M11 12h1v5h1"></path></svg>`,
  };
  let toastTimer = null;
  const toast = (title, sub, kind = "info") => {
    if (!toastEl) return;
    toastEl.className = `trace-toast ${kind}`;
    toastEl.innerHTML = `<span class="toast-ico">${TOAST_ICON[kind] || TOAST_ICON.info}</span>`
      + `<span class="toast-body"><span class="toast-title">${escapeHtml(title)}</span>`
      + (sub ? `<span class="toast-sub">${escapeHtml(sub)}</span>` : "")
      + `</span>`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.className = "trace-toast hidden"; }, 6000);
  };

  // Target defaults to the session's own user (userId null → server uses the
  // session user). The box is pre-filled with the current user's name; the ×
  // clears it so a different user can be searched. Leaving it blank/self keeps
  // the trace on yourself.
  let selfName = "your user";
  let target = { id: null, name: selfName };
  const showClear = (on) => clearBtn.classList.toggle("hidden", !on);
  const setTarget = (id, name) => { target = { id, name }; };
  // Pre-select the session user so the box opens showing who we'll trace.
  api(`/api/whoami?org=${encodeURIComponent(state.org)}`)
    .then((me) => {
      if (!overlay.isConnected) return;
      selfName = me.name || me.username || "your user";
      if (!target.id && !search.value) { search.value = selfName; showClear(true); }
    })
    .catch(() => {});
  clearBtn.addEventListener("click", () => {
    setTarget(null, "your user"); // blank = yourself
    search.value = ""; showClear(false); hideResults(); search.focus();
  });

  // Render one chip per user with a live trace flag; each × removes that user's
  // flag. This replaces the old single "Delete" button — deletion is per-user.
  const renderChips = async () => {
    try {
      const r = await api(`/api/traceflag-status?org=${encodeURIComponent(state.org)}`);
      if (!overlay.isConnected) return;
      setTraceIndicator(!!r.selfActive, r.expiration); // keep the toolbar dot honest
      const users = r.users || [];
      if (!users.length) { chips.innerHTML = `<span class="chips-empty">No active trace flags.</span>`; return; }
      chips.innerHTML = users.map((u) => {
        const until = u.expiration ? new Date(u.expiration).toLocaleTimeString() : "";
        const label = u.name + (u.isSelf ? " (you)" : "");
        return `<span class="trace-chip${u.isSelf ? " self" : ""}" title="${escapeHtml(u.username || u.name)}${until ? ` — until ${until}` : ""}">`
          + `<span class="chip-name">${escapeHtml(label)}</span>`
          + `<button class="chip-del" data-id="${escapeHtml(u.id)}" data-name="${escapeHtml(u.name)}" title="Remove trace flag for ${escapeHtml(u.name)}" aria-label="Remove trace flag for ${escapeHtml(u.name)}">${TRASH_SVG}</button>`
          + `</span>`;
      }).join("");
      chips.querySelectorAll(".chip-del").forEach((btn) => btn.addEventListener("click", () => removeFlag(btn)));
    } catch {
      if (overlay.isConnected) chips.innerHTML = `<span class="chips-empty">Couldn't load active trace flags.</span>`;
    }
  };
  const removeFlag = async (btn) => {
    const id = btn.getAttribute("data-id");
    const name = btn.getAttribute("data-name") || "that user";
    btn.disabled = true; btn.classList.add("busy");
    try {
      const r = await api("/api/traceflag", {
        method: "DELETE", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ org: state.org, userId: id }),
      });
      if (r.deleted) toast("Debug logging turned off", r.user, "success");
      else toast("No active trace flag", `Nothing to remove for ${name}.`, "info");
      await renderChips();
    } catch (e) {
      btn.disabled = false; btn.classList.remove("busy");
      toast("Couldn't remove the trace flag", e.message, "error");
    }
  };
  renderChips();

  // Debounced user search. Min 2 chars; clicking a result sets the target.
  let searchTimer = null, searchSeq = 0;
  const hideResults = () => { results.classList.add("hidden"); results.innerHTML = ""; };
  const runSearch = async (q) => {
    const seq = ++searchSeq;
    try {
      const r = await api(`/api/users?org=${encodeURIComponent(state.org)}&q=${encodeURIComponent(q)}`);
      if (!overlay.isConnected || seq !== searchSeq) return; // stale response
      const users = r.users || [];
      if (!users.length) { results.innerHTML = `<div class="lookup-empty">No matching active users.</div>`; results.classList.remove("hidden"); return; }
      results.innerHTML = users.map((u) =>
        `<button type="button" class="lookup-item" data-id="${escapeHtml(u.id)}" data-name="${escapeHtml(u.name)}">`
        + `<span class="li-name">${escapeHtml(u.name)}</span>`
        + `<span class="li-sub">${escapeHtml(u.username || u.email || "")}</span>`
        + `</button>`).join("");
      results.classList.remove("hidden");
      results.querySelectorAll(".lookup-item").forEach((item) => item.addEventListener("click", () => {
        const name = item.getAttribute("data-name");
        setTarget(item.getAttribute("data-id"), name);
        search.value = name; showClear(true); hideResults(); dur.focus(); // keep the chosen target visible
      }));
    } catch (e) {
      if (overlay.isConnected && seq === searchSeq) { results.innerHTML = `<div class="lookup-empty">${escapeHtml(e.message)}</div>`; results.classList.remove("hidden"); }
    }
  };
  search.addEventListener("input", () => {
    const q = search.value.trim();
    // Editing the field abandons any previously picked target; empty = yourself.
    if (target.id && q !== target.name) setTarget(null, "your user");
    clearTimeout(searchTimer);
    if (q.length < 2) { hideResults(); return; }
    searchTimer = setTimeout(() => runSearch(q), 250);
  });

  overlay.querySelector("#traceCancel").addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  const minutesOf = () => {
    const v = parseInt(dur.value, 10);
    if (!Number.isFinite(v) || v < 1) return null;
    return unit.value === "hour" ? v * 60 : v;
  };
  const validate = () => {
    const m = minutesOf();
    const ok = m != null && m <= 24 * 60;
    go.disabled = !ok;
    note.textContent = m != null && m > 24 * 60
      ? "That's over the 24-hour limit — choose a shorter duration."
      : "Salesforce caps a trace flag at 24 hours.";
  };
  dur.addEventListener("input", validate);
  unit.addEventListener("change", validate);
  dur.addEventListener("keydown", (e) => { if (e.key === "Enter" && !go.disabled) go.click(); });
  const submit = async () => {
    const minutes = minutesOf();
    if (minutes == null) return;
    go.disabled = true; go.textContent = "Creating…";
    try {
      const r = await api("/api/traceflag", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ org: state.org, minutes, userId: target.id || undefined }),
      });
      // Stay open — add/refresh the chip so multiple users can be set in a row.
      const until = r.expiration ? new Date(r.expiration).toLocaleTimeString() : "";
      if (r.alreadyActive) {
        toast("Already active", `${r.user}${until ? ` — until ${until}` : ""}`, "info");
      } else {
        toast("Debug logging enabled", `${r.user}${until ? ` — until ${until}` : ""}`, "success");
      }
      await renderChips();
      go.disabled = false; go.textContent = "Create";
      // Make sure the resulting logs stream in without a manual fetch.
      if (state.org) { if (!state.auto) setAuto(true); else startCapture(); }
    } catch (e) {
      go.disabled = false; go.textContent = "Create";
      toast("Couldn't enable debug logging", e.message, "error");
    }
  };
  go.addEventListener("click", submit);
  setTimeout(() => { search.focus(); }, 0);
}

// --- Salesforce knowledge search across MCP servers (Slack / OrgCS / GUS) ---
const SF_MCP_KEYS = ["orgcs", "slack", "gus"];

// Pull the errors worth researching out of the selected log(s): unhandled
// exceptions + fatal errors from the structured model, plus a failing list
// Status. De-duped so we don't research the same signature twice.
async function collectSfContext(ids, signal) {
  const blocks = [];
  const seen = new Set();
  let errorCount = 0;
  for (const id of ids) {
    if (signal && signal.aborted) throw new DOMException("aborted", "AbortError");
    const body = await getBody(id, signal);
    const m = window.ALA.buildModel(body || "");
    const lines = [];
    for (const e of m.exceptions) {
      const first = (e.type === "FATAL_ERROR" ? e.message : `${e.type}: ${e.message}`).split("\n")[0].trim();
      if (!first) continue;
      const dedupe = first.toLowerCase();
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      lines.push(`- [${e.kind}] ${first}`);
      errorCount++;
    }
    const it = allItems().find((x) => x.id === id);
    const failStatus = it && it.status && !/^success$/i.test(it.status) ? it.status : "";
    if (failStatus && !seen.has(failStatus.toLowerCase())) {
      seen.add(failStatus.toLowerCase());
      lines.push(`- [status] ${failStatus}`);
      errorCount++;
    }
    blocks.push(`### Log: ${labelFor(id)}\n${lines.length ? lines.join("\n") : "(no explicit exception/fatal lines — investigate anomalies in this log)"}`);
  }
  return { text: blocks.join("\n\n"), errorCount };
}

async function openSfModal() {
  const overlay = document.createElement("div");
  overlay.className = "modal";
  overlay.innerHTML = `
    <div class="modal-card">
      <h2>☁ Salesforce knowledge search</h2>
      <p class="hint">Uses your connected Claude Code MCP servers (read-only) to look up prior art on the errors in the selected log(s). Toggle which sources to include — a source you haven't authenticated stays off.</p>
      <div class="mcp-list" id="mcpList"><div class="empty"><span class="spinner"></span> Checking connections…</div></div>
      <p class="hint" id="sfHint"></p>
      <div class="modal-actions">
        <button id="sfRecheck" title="Re-probe MCP connections now">↻ Recheck</button>
        <span class="spacer"></span>
        <button id="sfCancel">Cancel</button>
        <button id="sfGo" class="primary" disabled>🔍 Analyze errors</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const listEl = overlay.querySelector("#mcpList");
  const go = overlay.querySelector("#sfGo");
  const hint = overlay.querySelector("#sfHint");
  const close = () => overlay.remove();
  overlay.querySelector("#sfCancel").addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });

  let servers = [];
  const refreshGo = () => {
    const enabled = [...(state.sfEnabled || [])];
    const ids = selectionIds();
    const connectedCount = servers.filter((s) => s.connected).length;
    let msg = "";
    if (!ids.length) msg = "Open or tick at least one log first.";
    else if (!enabled.length) msg = "Enable at least one connected source above.";
    else if (connectedCount === SF_MCP_KEYS.length && enabled.length === SF_MCP_KEYS.length) msg = "All three sources enabled — widest search.";
    else msg = `Searching ${enabled.length} of ${connectedCount} connected source${connectedCount === 1 ? "" : "s"}.`;
    hint.textContent = msg;
    go.disabled = !ids.length || !enabled.length;
  };

  const recheckBtn = overlay.querySelector("#sfRecheck");
  const load = async (fresh) => {
    listEl.innerHTML = `<div class="empty"><span class="spinner"></span> ${fresh ? "Re-probing connections…" : "Checking connections…"}</div>`;
    recheckBtn.disabled = true;
    try {
      // Always live-probe: a cold-start cached read can momentarily show a
      // slower remote server (e.g. OrgCS over HTTP) as not authenticated.
      const { servers: fetched = [] } = await api(`/api/mcp-status?fresh=${fresh ? 1 : 0}`);
      servers = fetched;
      // First open: default every CONNECTED server to enabled.
      if (state.sfEnabled == null) state.sfEnabled = new Set(servers.filter((s) => s.connected).map((s) => s.key));
      // A newly-connected server should turn on by default; never keep a
      // disconnected one enabled.
      for (const s of servers) {
        if (!s.connected) state.sfEnabled.delete(s.key);
        else if (fresh) state.sfEnabled.add(s.key);
      }
      listEl.innerHTML = "";
      for (const s of servers) {
        const on = state.sfEnabled.has(s.key);
        const row = document.createElement("div");
        row.className = "mcp-row";
        row.innerHTML = `
          <div class="mcp-info">
            <div class="mcp-name">${escapeHtml(s.label)}</div>
            <div class="mcp-state ${s.connected ? "ok" : "no"}">${s.connected ? "● Authenticated" : "○ Not authenticated"}</div>
          </div>
          <label class="mcp-toggle">
            <input type="checkbox" ${on ? "checked" : ""} ${s.connected ? "" : "disabled"} />
            <span class="track"><span class="knob"></span></span>
          </label>`;
        const cb = row.querySelector("input");
        cb.addEventListener("change", () => {
          if (cb.checked) state.sfEnabled.add(s.key); else state.sfEnabled.delete(s.key);
          refreshGo();
        });
        listEl.appendChild(row);
      }
      refreshGo();
    } catch (e) {
      listEl.innerHTML = `<div class="empty" style="color:var(--red)">${escapeHtml(e.message)}</div>`;
    } finally {
      recheckBtn.disabled = false;
    }
  };
  recheckBtn.addEventListener("click", () => load(true));
  await load(false);

  go.addEventListener("click", () => {
    const enabled = [...(state.sfEnabled || [])];
    const ids = selectionIds();
    if (!ids.length || !enabled.length) return;
    close();
    runSfAnalyze(ids, enabled);
  });
}

function runSfAnalyze(ids, enabled) {
  const names = { orgcs: "OrgCS", slack: "Slack", gus: "GUS" };
  const which = enabled.map((k) => names[k] || k).join(" + ");
  return runPanel(`☁ Salesforce — searching ${which} in parallel`, async (signal) => {
    const { text: context, errorCount } = await collectSfContext(ids, signal);
    if (!errorCount) {
      return { text: "**No errors found** in the selected log(s) — nothing to research. Open a log that contains an exception, fatal error, or a failed status and try again.", chatLogText: null };
    }
    // The actual log text: sent so the final report can review OUR scenario (not
    // just the prior art) and give concrete fix steps, and used as the context
    // for follow-up chat afterward.
    const logText = await collectLogText(ids, signal);
    const { text } = await api("/api/sf-analyze", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled, context, logText }), signal,
    });
    return { text, chatLogText: logText };
  });
}

// --- #5 Diagnose — ranked root-cause report from the full-log digest -------
// We send Claude the STRUCTURED DIGEST (extracted from the whole log) instead of
// truncated raw text, so it reasons over full signal at a fraction of the tokens.
function runDiagnose() {
  if (!state.logBody) { status("Open a log first.", "error"); return; }
  const digest = window.ALA.buildDigest(currentModel(), labelFor(state.selectedId));
  return runPanel("🔍 Check this log with Claude — ranked root causes", async (signal) => {
    const { text } = await api("/api/diagnose", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ org: state.org, digest }), signal,
    });
    return { text, chatLogText: digest };
  });
}

// --- #5 Export — a shareable Markdown brief (digest + Claude conversation) --
function buildInvestigationMarkdown() {
  const parts = [`# Apex Log Investigation`, `\n*Exported ${new Date().toLocaleString()}*`];
  if (state.selectedId != null) parts.push(`\n**Log:** ${labelFor(state.selectedId)}`);
  if (state.logBody) parts.push("\n---\n\n" + window.ALA.buildDigest(currentModel(), labelFor(state.selectedId)));
  const hist = state.analysisCtx && state.analysisCtx.history;
  if (hist && hist.length) {
    parts.push("\n---\n\n## Claude analysis");
    for (const h of hist) parts.push(`\n### ${h.role === "user" ? "Question" : "Claude"}\n\n${h.text}`);
  }
  return parts.join("\n");
}
function exportInvestigation() {
  if (!state.logBody && !(state.analysisCtx && state.analysisCtx.history.length)) { status("Nothing to export yet.", "error"); return; }
  const name = `apex-investigation-${state.selectedId || "log"}.md`.replace(/[^\w.-]/g, "_");
  triggerDownload(name, buildInvestigationMarkdown());
  status("Exported investigation as Markdown.", "success");
  setTimeout(clearStatus, 2000);
}

// --- #4 Related — transaction / async correlation --------------------------
// One user action fires several logs (async @future/Queueable/Batch, flows).
// Surface the sibling logs from the same user within a short window so they can
// be analyzed together as one transaction.
function openRelated() {
  if (state.selectedId == null || findUpload(state.selectedId)) { status("Open an org log first.", "error"); return; }
  const m = currentModel();
  const self = allItems().find((i) => i.id === state.selectedId);
  const selfMs = self && self.time ? new Date(self.time).getTime() : null;
  const WINDOW = 5 * 60 * 1000;
  const related = state.logs.map(orgItem).filter((it) => {
    if (it.id === state.selectedId) return false;
    if (self && self.user && it.user && it.user !== self.user) return false;
    return selfMs && it.time ? Math.abs(new Date(it.time).getTime() - selfMs) <= WINDOW : false;
  }).sort((a, b) => new Date(a.time) - new Date(b.time));

  const overlay = document.createElement("div");
  overlay.className = "modal";
  const asyncNote = m.asyncKinds.length
    ? `<p class="hint">This transaction spawns async work: <b>${m.asyncKinds.map(escapeHtml).join(", ")}</b> — its results usually land in a separate log below.</p>`
    : `<p class="hint">No async work detected in this log. Related logs below share the same user + time window.</p>`;
  const rows = related.length
    ? related.map((it) => `<label class="rel-row"><input type="checkbox" checked data-id="${it.id}" /> <span>${fmtTime(it.time)} · ${escapeHtml(it.operation || "")} · <span class="status-pill ${it.ok ? "ok" : "err"}">${escapeHtml(it.status)}</span></span></label>`).join("")
    : `<p class="hint">No sibling logs found in the same 5-minute window.</p>`;
  overlay.innerHTML = `
    <div class="modal-card modal-card--wide">
      <h2>🔗 Related logs (same transaction)</h2>
      ${asyncNote}
      <div class="rel-list">${rows}</div>
      <div class="modal-actions">
        <button id="relCancel">Cancel</button>
        <button id="relGo" class="primary"${related.length ? "" : " disabled"}>Analyze together</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector("#relCancel").addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  overlay.querySelector("#relGo").addEventListener("click", () => {
    const ids = [state.selectedId, ...[...overlay.querySelectorAll(".rel-row input:checked")].map((c) => c.getAttribute("data-id"))];
    close();
    runAnalysisFor(ids);
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
  els.autoBtn.addEventListener("click", () => setAuto(!state.auto));
  els.uploadBtn.addEventListener("click", () => els.fileInput.click());
  els.fileInput.addEventListener("change", (e) => { addFiles(e.target.files); e.target.value = ""; });
  // Picking an org begins auto-capture immediately when auto-refresh is ON: we
  // start polling the org so any new logs stream in on their own — no "Fetch"
  // click needed. (This only reads existing logs; it never enables debug
  // logging. Use "Start debug logging" for that.) With auto OFF we fall back to
  // the manual time-window + Fetch flow.
  els.orgSelect.addEventListener("change", () => {
    const val = els.orgSelect.value;
    // A logged-in-but-unusable org (valid Chrome session, but Salesforce refuses
    // the API — e.g. an IP restriction). Don't switch to it: every call would
    // fail the same way. Stay on the current page, flag it with a toast error,
    // and revert the picker to whatever was selected before.
    const blocked = val && state.orgBlocked[val];
    if (blocked) {
      toast(blocked, "error", `Can't use ${val}`);
      els.orgSelect.value = state.org || "";
      return;
    }
    state.org = val;
    state.fetched = false;
    stopPolling();
    resetView();
    loadWhoami();
    if (state.org && state.auto) {
      state.fetched = true;
      startCapture(); // auto-capture: refresh now + keep polling (also paints the indicator)
    } else if (state.org) {
      refreshTraceStatus(); // still show the red/green debug-log status
      status("Choose a time window and click “Fetch logs”.", "info");
    } else {
      setTraceIndicator(false); // no org — reset to red
    }
  });
  els.fetchBtn.addEventListener("click", fetchLogsClicked);
  els.fetchAllBtn.addEventListener("click", () => fetchLogsClicked({ all: true }));
  els.windowMin.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); fetchLogsClicked(); } });
  els.search.addEventListener("input", () => { state.query = els.search.value; searchInstant(); });
  els.search.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); searchInstant(); } });
  els.selectAll.addEventListener("change", (e) => {
    const on = e.target.checked;
    for (const it of state.filtered) { if (on) state.checked.add(it.id); else state.checked.delete(it.id); }
    updateBulkBar(); renderRows();
  });
  els.analyzeSelected.addEventListener("click", analyzeSelected);
  els.downloadSelected.addEventListener("click", downloadSelected);
  els.deleteLogsBtn.addEventListener("click", () => {
    // Act on the ticked set, or the single open log if nothing's ticked.
    const ids = state.checked.size ? [...state.checked]
      : (state.selectedId != null ? [state.selectedId] : []);
    deleteItems(ids);
  });
  els.codeHealthBtn.addEventListener("click", runCodeHealth);
  els.compareBtn.addEventListener("click", enterCompareMode);
  els.compareCancel.addEventListener("click", exitCompareMode);
  els.compareNext.addEventListener("click", compareNext);
  els.compareRun.addEventListener("click", compareRun);
  els.onSaveBtn.addEventListener("click", openOnSave);
  els.traceBtn.addEventListener("click", openTraceFlag);
  els.sfBtn.addEventListener("click", openSfModal);
  els.viewRaw.addEventListener("click", () => setViewMode("raw"));
  els.viewProfile.addEventListener("click", () => setViewMode("profile"));
  els.viewFlame.addEventListener("click", () => setViewMode("flame"));
  els.viewQueries.addEventListener("click", () => setViewMode("queries"));
  els.viewIssues.addEventListener("click", () => setViewMode("issues"));
  els.viewVars.addEventListener("click", () => setViewMode("vars"));
  els.explainProfile.addEventListener("click", explainProfile);
  els.diagnoseBtn.addEventListener("click", runDiagnose);
  els.relatedBtn.addEventListener("click", openRelated);
  els.exportBtn.addEventListener("click", exportInvestigation);
  els.exportAnalysis.addEventListener("click", exportInvestigation);
  els.closeAnalysis.addEventListener("click", hideAnalysis);
  // noise filter (raw view)
  els.facetBar.querySelectorAll("input[data-cat]").forEach((cb) => {
    cb.addEventListener("change", () => {
      const cat = cb.getAttribute("data-cat");
      if (cb.checked) state.rawFilter.add(cat); else state.rawFilter.delete(cat);
      renderLog();
    });
  });
  if (els.collapseDupes) els.collapseDupes.addEventListener("change", () => { state.collapseDupes = els.collapseDupes.checked; renderLog(); });
  els.facetClear.addEventListener("click", () => { state.rawFilter.clear(); state.collapseDupes = false; syncFacetUI(); renderLog(); });
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
  window.addEventListener("resize", () => {
    if (state.viewMode !== "flame" || !state.logBody) return;
    clearTimeout(flameResizeTimer);
    flameResizeTimer = setTimeout(renderFlame, 120);
  });
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
  updateChrome(); // paint the correct cold-start chrome (hero vs. toolbar) before the first frame — no flash
  loadModel();
  await loadOrgs({ fresh: true }); // page load = live re-check, never a stale cache
  updateChrome(); // reveal org-gated controls right away if an org is already selected
  if (els.orgSelect.value) await startCapture();
  else applyFilter();
  // Keep the org list fresh (e.g. after logging into a new org in Chrome).
  setInterval(loadOrgs, 5000);
  // …and re-check the instant the user returns to this tab — the usual flow is
  // "log into the org in Chrome, switch back here", so this makes the org show
  // up immediately instead of waiting for the next poll tick.
  window.addEventListener("focus", () => loadOrgs({ fresh: true }));
  document.addEventListener("visibilitychange", () => { if (!document.hidden) loadOrgs({ fresh: true }); });
}
init().catch((e) => status(`Failed to start: ${e && e.message ? e.message : e}`, "error"));
