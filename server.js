#!/usr/bin/env node
// Apex Log Analyzer — local web app (zero manual steps).
//
// Reads the Salesforce session straight from Chrome's cookie store (see
// chrome-session.js), so whatever org you're logged into in Chrome just shows
// up. Auto-enables debug logging and auto-polls for new logs. All Salesforce +
// Claude calls happen here (server-side): no extension, no CORS.
//
//     node server.js   ->   open http://localhost:8787

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");
const { detectOrgSessions, diagnose } = require("./chrome-session");

const PORT = process.env.PORT || 8787;
const WEB_DIR = path.join(__dirname, "web");
const SETTINGS_PATH = path.join(os.homedir(), ".apex-log-analyzer.json");
const DEFAULT_API_VERSION = "61.0";

// --- settings -------------------------------------------------------------
function loadSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8")); } catch { return {}; }
}
function saveSettings(s) { fs.writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2), { mode: 0o600 }); }
function getApiKey() { return process.env.ANTHROPIC_API_KEY || loadSettings().apiKey || ""; }
function getModel() { return loadSettings().model || "claude-sonnet-5"; }

// --- sessions from Chrome -------------------------------------------------
let orgCache = { at: 0, orgs: [] };
function getOrgs() {
  const now = Date.now();
  if (now - orgCache.at < 4000 && orgCache.orgs.length) return orgCache.orgs;
  const orgs = detectOrgSessions();
  orgCache = { at: now, orgs };
  return orgs;
}

const versionCache = new Map();
async function resolveApiVersion(session) {
  if (versionCache.has(session.apiHost)) return versionCache.get(session.apiHost);
  let v = DEFAULT_API_VERSION;
  try {
    const res = await rawFetch(session, "/services/data/");
    const arr = await res.json();
    if (Array.isArray(arr) && arr.length) v = arr[arr.length - 1].version;
  } catch { /* keep default */ }
  versionCache.set(session.apiHost, v);
  return v;
}

function findOrg(apiHost) {
  const org = getOrgs().find((o) => o.apiHost === apiHost);
  if (!org) {
    throw new Error(`No Chrome session for "${apiHost}". Log into the org in Chrome, then Refresh.`);
  }
  return { apiHost: org.apiHost, sessionId: org.sessionId, instanceUrl: `https://${org.apiHost}` };
}
async function getSession(apiHost) {
  const s = findOrg(apiHost);
  s.apiVersion = await resolveApiVersion(s);
  return s;
}

async function rawFetch(session, urlPath, opts = {}) {
  const url = urlPath.startsWith("http") ? urlPath : session.instanceUrl + urlPath;
  const res = await fetch(url, {
    ...opts,
    headers: {
      Authorization: `Bearer ${session.sessionId}`,
      Accept: opts.accept || "application/json",
      ...(opts.body ? { "Content-Type": "application/json" } : {}),
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let msg = `${res.status} ${res.statusText}`;
    try {
      const j = JSON.parse(text);
      const first = Array.isArray(j) ? j[0] : j;
      if (first && (first.message || first.error_description)) msg = first.message || first.error_description;
    } catch { if (text) msg = text.slice(0, 300); }
    if (res.status === 401) msg = "Session expired or invalid — reload the org in Chrome, then Refresh.";
    throw new Error(msg);
  }
  return res;
}

// --- Salesforce operations ------------------------------------------------
function listOrgsForUi() {
  const orgs = getOrgs();
  return orgs.map((o) => ({ value: o.apiHost, label: o.label, profile: o.profile }));
}

async function listLogs(apiHost) {
  const s = await getSession(apiHost);
  const soql =
    "SELECT Id, LogUser.Name, Operation, Application, Status, LogLength, " +
    "Request, StartTime, DurationMilliseconds FROM ApexLog ORDER BY StartTime DESC LIMIT 200";
  const res = await rawFetch(s, `/services/data/v${s.apiVersion}/tooling/query/?q=${encodeURIComponent(soql)}`);
  return (await res.json()).records || [];
}

const bodyCache = new Map(); // apiHost:id -> text (log bodies are immutable)
async function getLogBody(apiHost, id) {
  const cacheKey = `${apiHost}:${id}`;
  if (bodyCache.has(cacheKey)) return bodyCache.get(cacheKey);
  const s = await getSession(apiHost);
  const res = await rawFetch(s, `/services/data/v${s.apiVersion}/tooling/sobjects/ApexLog/${id}/Body`, { accept: "text/plain" });
  const text = await res.text();
  bodyCache.set(cacheKey, text);
  if (bodyCache.size > 500) bodyCache.delete(bodyCache.keys().next().value);
  return text;
}

// Run an async fn over items with bounded concurrency.
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

// Full-text search across the bodies of all recent logs. Returns matching log
// ids + a short snippet around the first hit.
async function searchLogs(apiHost, q) {
  const needle = q.toLowerCase();
  const logs = await listLogs(apiHost);
  const found = await mapLimit(logs, 8, async (l) => {
    try {
      const body = await getLogBody(apiHost, l.Id);
      const idx = body.toLowerCase().indexOf(needle);
      if (idx < 0) return null;
      const start = Math.max(0, idx - 60);
      const snippet = body.slice(start, idx + q.length + 100).replace(/\s+/g, " ").trim();
      const count = body.toLowerCase().split(needle).length - 1;
      return { id: l.Id, snippet: (start > 0 ? "…" : "") + snippet + "…", count };
    } catch {
      return null;
    }
  });
  return found.filter(Boolean);
}

// True if a currently-active USER_DEBUG trace flag exists for the current user.
async function hasActiveTraceFlag(apiHost) {
  const s = await getSession(apiHost);
  const info = await (await rawFetch(s, "/services/oauth2/userinfo")).json();
  const now = new Date().toISOString();
  const q = `SELECT Id FROM TraceFlag WHERE TracedEntityId = '${info.user_id}' AND LogType = 'USER_DEBUG' AND ExpirationDate > ${now}`;
  const res = await rawFetch(s, `/services/data/v${s.apiVersion}/tooling/query/?q=${encodeURIComponent(q)}`);
  return ((await res.json()).records || []).length > 0;
}

async function enableLogging(apiHost, hours = 12) {
  const s = await getSession(apiHost);
  const v = s.apiVersion;
  const info = await (await rawFetch(s, "/services/oauth2/userinfo")).json();
  const userId = info.user_id;

  const dlName = "ApexLogAnalyzer";
  const dlq = await (await rawFetch(s,
    `/services/data/v${v}/tooling/query/?q=${encodeURIComponent(`SELECT Id FROM DebugLevel WHERE DeveloperName = '${dlName}' LIMIT 1`)}`)).json();
  let debugLevelId = dlq.records && dlq.records[0] && dlq.records[0].Id;
  if (!debugLevelId) {
    const created = await (await rawFetch(s, `/services/data/v${v}/tooling/sobjects/DebugLevel`, {
      method: "POST",
      body: JSON.stringify({
        DeveloperName: dlName, MasterLabel: dlName,
        ApexCode: "FINE", ApexProfiling: "INFO", Callout: "INFO", Database: "INFO",
        System: "DEBUG", Validation: "INFO", Visualforce: "INFO", Workflow: "INFO", Nba: "NONE", Wave: "NONE",
      }),
    })).json();
    debugLevelId = created.id;
  }

  const existing = await (await rawFetch(s,
    `/services/data/v${v}/tooling/query/?q=${encodeURIComponent(`SELECT Id FROM TraceFlag WHERE TracedEntityId = '${userId}' AND LogType = 'USER_DEBUG'`)}`)).json();
  for (const rec of existing.records || []) {
    await rawFetch(s, `/services/data/v${v}/tooling/sobjects/TraceFlag/${rec.Id}`, { method: "DELETE" }).catch(() => {});
  }

  const now = new Date();
  const expiration = new Date(now.getTime() + hours * 3600 * 1000);
  await rawFetch(s, `/services/data/v${v}/tooling/sobjects/TraceFlag`, {
    method: "POST",
    body: JSON.stringify({
      TracedEntityId: userId, DebugLevelId: debugLevelId, LogType: "USER_DEBUG",
      StartDate: now.toISOString(), ExpirationDate: expiration.toISOString(),
    }),
  });
  return { expiration: expiration.toISOString() };
}

// --- Claude ---------------------------------------------------------------
const CLAUDE_SYSTEM = `You are an expert Salesforce developer analyzing Apex debug logs.
Given a raw Apex debug log, produce a clear, concise analysis with these sections (omit any that don't apply):

## Summary
One or two sentences: what happened and whether it succeeded or failed.

## Errors & Exceptions
Any exceptions, FATAL_ERROR, or DML/SOQL failures, with the line/context.

## Governor Limits
SOQL queries, DML statements, CPU time, heap, callouts used vs. limits. Flag anything near a limit.

## Performance
The slowest operations/methods and any obvious bottlenecks (long DURATION values, loops with queries, etc.).

## Root Cause & Recommendations
The likely root cause of any problem and specific, actionable fixes.

Be precise, reference concrete values from the log, and use Markdown.`;

const MAX_LOG_CHARS = 160000;
function truncateLog(body) {
  if (body.length <= MAX_LOG_CHARS) return { text: body, truncated: false };
  const head = Math.floor(MAX_LOG_CHARS * 0.55);
  const tail = MAX_LOG_CHARS - head;
  return {
    text: body.slice(0, head) + `\n\n... [${body.length - MAX_LOG_CHARS} characters trimmed] ...\n\n` + body.slice(body.length - tail),
    truncated: true,
  };
}
async function analyzeViaApi(apiKey, userContent) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: getModel(), max_tokens: 3000, system: CLAUDE_SYSTEM, messages: [{ role: "user", content: userContent }] }),
  });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try { const j = await res.json(); if (j.error && j.error.message) msg = j.error.message; } catch {}
    throw new Error(`Claude API error: ${msg}`);
  }
  const data = await res.json();
  return (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
}

function cliModelArg() {
  const m = getModel();
  if (/opus/i.test(m)) return "opus";
  if (/haiku/i.test(m)) return "haiku";
  return "sonnet";
}

// Zero-key path: use the locally installed Claude Code CLI (`claude -p`), which
// runs under the user's existing login. The instruction is the -p arg; the
// (large) log is piped via stdin — the documented `cat file | claude -p` form.
function analyzeViaCli(instruction, stdinText) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "claude",
      ["-p", instruction, "--model", cliModelArg()],
      { maxBuffer: 32 * 1024 * 1024, timeout: 240000 },
      (err, stdout, stderr) => {
        if (err) {
          if (err.code === "ENOENT") {
            return reject(new Error("Claude Code CLI ('claude') not found on PATH. Install it, or set an ANTHROPIC_API_KEY in Settings."));
          }
          return reject(new Error(String(stderr || err.message || "claude CLI failed").slice(0, 400)));
        }
        resolve(String(stdout || "").trim());
      }
    );
    child.stdin.end(stdinText);
  });
}

async function analyze({ apiHost, id, question }) {
  const body = await getLogBody(apiHost, id);
  const { text, truncated } = truncateLog(body);
  const truncNote = truncated ? "\nNote: this log was trimmed (head + tail kept) because it is large." : "";
  const apiKey = getApiKey();
  if (apiKey) {
    const userContent =
      (question ? `The user is specifically asking: "${question}"\n\n` : "") +
      (truncated ? "Note: this log was trimmed (head + tail kept) because it is large.\n\n" : "") +
      "Here is the Apex debug log:\n\n```\n" + text + "\n```";
    return analyzeViaApi(apiKey, userContent);
  }
  // No key configured -> use the local Claude Code CLI (no manual step).
  const instruction =
    CLAUDE_SYSTEM +
    (question ? `\n\nThe user is specifically asking: "${question}"` : "") +
    truncNote +
    "\n\nThe raw Apex debug log to analyze is provided on standard input. Do not use any tools; just analyze the log text.";
  return analyzeViaCli(instruction, text);
}

// --- HTTP -----------------------------------------------------------------
function sendJson(res, code, obj) { const s = JSON.stringify(obj); res.writeHead(code, { "Content-Type": "application/json" }); res.end(s); }
function readBody(req) {
  return new Promise((resolve) => {
    let data = ""; req.on("data", (c) => (data += c));
    req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
  });
}
const MIME = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript" };
function serveStatic(res, urlPath) {
  const file = urlPath === "/" ? "app.html" : urlPath.replace(/^\//, "");
  const full = path.join(WEB_DIR, file);
  if (!full.startsWith(WEB_DIR) || !fs.existsSync(full)) { res.writeHead(404); return res.end("Not found"); }
  res.writeHead(200, { "Content-Type": MIME[path.extname(full)] || "text/plain" });
  fs.createReadStream(full).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  const p = u.pathname;
  try {
    if (!p.startsWith("/api/")) return serveStatic(res, p);
    if (p === "/api/orgs") return sendJson(res, 200, { orgs: listOrgsForUi() });
    if (p === "/api/diag") return sendJson(res, 200, diagnose());
    if (p === "/api/logs") return sendJson(res, 200, { records: await listLogs(u.searchParams.get("org")) });
    if (p === "/api/search") return sendJson(res, 200, { matches: await searchLogs(u.searchParams.get("org"), u.searchParams.get("q") || "") });
    if (p === "/api/logbody") {
      const body = await getLogBody(u.searchParams.get("org"), u.searchParams.get("id"));
      res.writeHead(200, { "Content-Type": "text/plain" }); return res.end(body);
    }
    if (p === "/api/trace-status") return sendJson(res, 200, { active: await hasActiveTraceFlag(u.searchParams.get("org")) });
    if (p === "/api/enable-logging" && req.method === "POST") {
      const { org } = await readBody(req); return sendJson(res, 200, await enableLogging(org));
    }
    if (p === "/api/analyze" && req.method === "POST") {
      const { org, id, question } = await readBody(req);
      return sendJson(res, 200, { text: await analyze({ apiHost: org, id, question }) });
    }
    if (p === "/api/settings") {
      if (req.method === "POST") {
        const { apiKey, model } = await readBody(req);
        const cur = loadSettings();
        if (apiKey !== undefined) cur.apiKey = apiKey;
        if (model !== undefined) cur.model = model;
        saveSettings(cur);
        return sendJson(res, 200, { ok: true });
      }
      return sendJson(res, 200, { hasKey: !!getApiKey(), keyFromEnv: !!process.env.ANTHROPIC_API_KEY, model: getModel() });
    }
    sendJson(res, 404, { error: "Unknown endpoint" });
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
});

// --- startup --------------------------------------------------------------
// node:sqlite (used by chrome-session.js) needs a recent Node. Fail early with
// a clear message instead of a cryptic require error mid-run.
const NODE_MAJOR = Number(process.versions.node.split(".")[0]);
if (NODE_MAJOR < 22) {
  console.error(`\n  Apex Log Analyzer needs Node.js 22 or newer (you have ${process.version}).`);
  console.error(`  Install the latest Node from https://nodejs.org and try again.\n`);
  process.exit(1);
}

function openBrowser(url) {
  if (process.env.NO_OPEN) return;
  const cmd = process.platform === "darwin" ? "open"
    : process.platform === "win32" ? "start" : "xdg-open";
  execFile(cmd, [url], () => {}); // best-effort; ignore failures
}

// Bind to the requested port, falling back to the next few if it's taken so a
// second copy (or a leftover process) doesn't crash the launch.
function listen(port, attemptsLeft = 10) {
  server.once("error", (err) => {
    if (err.code === "EADDRINUSE" && attemptsLeft > 0) {
      console.log(`  Port ${port} is busy — trying ${port + 1}…`);
      listen(port + 1, attemptsLeft - 1);
    } else {
      console.error(`  Could not start server: ${err.message}`);
      process.exit(1);
    }
  });
  server.listen(port, "127.0.0.1", () => {
    const url = `http://localhost:${port}`;
    console.log(`\n  ⚡ Apex Log Analyzer running at  ${url}\n`);
    console.log(`  Reading the Salesforce session from Chrome — just log into your org in Chrome.`);
    console.log(`  (macOS may show a one-time Keychain "Allow" prompt — click Always Allow.)`);
    console.log(`  Settings file: ${SETTINGS_PATH}`);
    if (!getApiKey()) console.log(`  Claude analysis uses your local "claude" CLI — no API key needed.\n`);
    openBrowser(url);
  });
}
listen(Number(PORT));
