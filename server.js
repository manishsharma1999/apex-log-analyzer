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

// chrome-session.js relies on the built-in node:sqlite module, which is only
// usable (without a flag) on Node 22.13+ / 24+. Check up front and fail with a
// clear message instead of a cryptic require error.
try {
  require("node:sqlite");
} catch {
  console.error(`\n  Apex Log Analyzer needs a newer Node.js (you have ${process.version}).`);
  console.error(`  Please use Node 24 LTS (or 22.13+). The double-click launcher installs`);
  console.error(`  a compatible Node automatically; or get it from https://nodejs.org\n`);
  process.exit(1);
}

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

// Pending shutdown timer, armed by /api/bye and cancelled by /api/heartbeat.
let pendingQuit = null;

// Opt-in outbound-request tracer (ALA_TRACE=1). Prints METHOD + host + path for
// every network call the app makes, so you can watch that Salesforce traffic is
// GET-only (read-only). No effect on behavior; off by default.
function traceHttp(method, url) {
  if (!process.env.ALA_TRACE) return;
  try {
    const u = new URL(url);
    console.log(`  [http] ${String(method || "GET").toUpperCase().padEnd(6)} ${u.host}${u.pathname}${u.search ? "?…" : ""}`);
  } catch {
    console.log(`  [http] ${String(method || "GET").toUpperCase()} ${url}`);
  }
}

// --- sessions from Chrome -------------------------------------------------
let orgCache = { at: 0, orgs: [] };
function getOrgs(force = false) {
  const now = Date.now();
  if (!force && now - orgCache.at < 4000 && orgCache.orgs.length) return orgCache.orgs;
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
  traceHttp(opts.method, url);
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
// Only show orgs whose session actually works right now: a valid sid returns
// 200 from /services/oauth2/userinfo; an expired/invalid one returns 401/403.
// Cached ~60s per host so we don't re-check on every poll.
const sessionOkCache = new Map(); // apiHost -> { at, ok }
async function sessionActive(org, force = false) {
  const now = Date.now();
  const cached = sessionOkCache.get(org.apiHost);
  // Cache a live session for 60s (no need to re-check a known-good org every
  // poll), but a "not valid" result for only ~4s: a just-logged-in org whose
  // session was briefly invalid mid-login then shows up almost immediately
  // instead of being hidden for a full minute. `force` (a user Refresh / tab
  // focus) bypasses the cache entirely so a just-logged-OUT org disappears at
  // once instead of lingering for the rest of its cached 60s.
  if (!force && cached && now - cached.at < (cached.ok ? 60000 : 4000)) return cached.ok;
  let ok = false;
  try {
    // Hit the same REST API the app actually uses. redirect:"manual" so an
    // expired session (which 302s to the login page) isn't mistaken for a live
    // 200. 200 = valid; 403 = valid session but no perm; 401/302 = expired.
    traceHttp("GET", `https://${org.apiHost}/services/data/v59.0/limits`);
    const res = await fetch(`https://${org.apiHost}/services/data/v59.0/limits`, {
      headers: { Authorization: `Bearer ${org.sessionId}`, Accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
    });
    ok = res.status === 200 || res.status === 403;
  } catch { ok = false; }
  sessionOkCache.set(org.apiHost, { at: now, ok });
  return ok;
}
async function listOrgsForUi(force = false) {
  const orgs = getOrgs(force);
  const checked = await Promise.all(orgs.map(async (o) => ({ o, ok: await sessionActive(o, force) })));
  return checked.filter((c) => c.ok).map((c) => ({ value: c.o.apiHost, label: c.o.label }));
}

async function listLogs(apiHost, mins) {
  const s = await getSession(apiHost);
  // Optional time window: only pull logs created in the last N minutes, so we
  // don't drag down the whole org. SOQL datetime literals are unquoted ISO8601
  // with no milliseconds (e.g. 2026-09-19T12:00:00Z).
  let where = "";
  const m = Number(mins);
  if (Number.isFinite(m) && m > 0) {
    const since = new Date(Date.now() - m * 60000).toISOString().replace(/\.\d{3}Z$/, "Z");
    where = ` WHERE StartTime >= ${since}`;
  }
  const soql =
    "SELECT Id, LogUser.Name, Operation, Application, Status, LogLength, " +
    "Request, StartTime, DurationMilliseconds FROM ApexLog" + where +
    " ORDER BY StartTime DESC LIMIT 200";
  const res = await rawFetch(s, `/services/data/v${s.apiVersion}/tooling/query/?q=${encodeURIComponent(soql)}`);
  return (await res.json()).records || [];
}

const bodyCache = new Map(); // apiHost:id -> text (log bodies are immutable)
async function getLogBody(apiHost, id) {
  // id goes straight into the Salesforce REST path — pin it to a real 15/18-char
  // Salesforce record id so a crafted value can't reshape the request path.
  if (!/^[0-9A-Za-z]{15,18}$/.test(String(id || ""))) throw new Error("Invalid log id.");
  const cacheKey = `${apiHost}:${id}`;
  if (bodyCache.has(cacheKey)) return bodyCache.get(cacheKey);
  const s = await getSession(apiHost);
  const res = await rawFetch(s, `/services/data/v${s.apiVersion}/tooling/sobjects/ApexLog/${id}/Body`, { accept: "text/plain" });
  const text = await res.text();
  bodyCache.set(cacheKey, text);
  if (bodyCache.size > 500) bodyCache.delete(bodyCache.keys().next().value);
  return text;
}

// Identity of the user whose Chrome session we're using — so the operator can
// always see which Salesforce user this tool is acting as. Read-only GET to the
// standard OpenID Connect userinfo endpoint. Cached per host (identity is stable
// for the life of a session).
const identityCache = new Map(); // apiHost:sessionId -> { name, username, orgId }
async function whoami(apiHost) {
  const s = await getSession(apiHost);
  // Key on the session id, not just the host: logging out and back in as a
  // different user on the same org must not return the previous user's name.
  const cacheKey = `${apiHost}:${s.sessionId}`;
  if (identityCache.has(cacheKey)) return identityCache.get(cacheKey);
  const res = await rawFetch(s, "/services/oauth2/userinfo");
  const j = await res.json();
  const info = {
    name: j.name || j.preferred_username || j.nickname || "",
    username: j.preferred_username || j.email || "",
    orgId: j.organization_id || "",
  };
  if (identityCache.size > 50) identityCache.delete(identityCache.keys().next().value);
  identityCache.set(cacheKey, info);
  return info;
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
      const lower = body.toLowerCase();
      const idx = lower.indexOf(needle);
      if (idx < 0) return null;
      const start = Math.max(0, idx - 60);
      const snippet = body.slice(start, idx + q.length + 100).replace(/\s+/g, " ").trim();
      const count = lower.split(needle).length - 1;
      // 1-based line number of the first hit (matches the viewer's gutter).
      let line = 1;
      for (let i = 0; i < idx; i++) if (body.charCodeAt(i) === 10) line++;
      return { id: l.Id, snippet: (start > 0 ? "…" : "") + snippet + "…", count, line };
    } catch {
      return null;
    }
  });
  return found.filter(Boolean);
}

// --- read-only helpers (chat enrichment + feature endpoints) --------------
// Every call below is a GET/SELECT — nothing here writes to the org.

// Defense-in-depth: escape a value going into a SOQL string literal. These come
// from parsed logs / user questions, so treat them as untrusted.
function soqlLiteral(v) { return String(v || "").replace(/[\\']/g, "\\$&"); }

async function toolingQuery(session, soql) {
  const res = await rawFetch(session, `/services/data/v${session.apiVersion}/tooling/query/?q=${encodeURIComponent(soql)}`);
  return (await res.json()).records || [];
}
async function restQuery(session, soql) {
  const res = await rawFetch(session, `/services/data/v${session.apiVersion}/query/?q=${encodeURIComponent(soql)}`);
  return (await res.json()).records || [];
}

// The SOQL queries a log actually ran (from its SOQL_EXECUTE_BEGIN lines).
function extractSoql(logText) {
  const seen = new Set(); const out = [];
  for (const line of String(logText).split("\n")) {
    if (!line.includes("|SOQL_EXECUTE_BEGIN|")) continue;
    // ts|SOQL_EXECUTE_BEGIN|[line]|Aggregations:n|SELECT ...  — query is field 5+
    const q = line.split("|").slice(4).join("|").trim();
    if (/^SELECT\b/i.test(q) && !seen.has(q)) { seen.add(q); out.push(q); }
    if (out.length >= 8) break;
  }
  return out;
}

// The user a log ran as (from its USER_INFO line).
function extractRunningUser(logText) {
  for (const line of String(logText).split("\n")) {
    if (!line.includes("|USER_INFO|")) continue;
    const parts = line.split("|");
    const idx = parts.findIndex((p) => /^005[0-9A-Za-z]{12,15}$/.test(p));
    if (idx >= 0) return { id: parts[idx], username: parts[idx + 1] || "" };
  }
  return null;
}

// Apex classes/triggers that executed (from CODE_UNIT / METHOD / CONSTRUCTOR lines).
function extractApexUnits(logText) {
  const names = new Set();
  for (const line of String(logText).split("\n")) {
    if (!/\|(CODE_UNIT_STARTED|METHOD_ENTRY|CONSTRUCTOR_ENTRY)\|/.test(line)) continue;
    // Trigger label can sit in a middle field (last field is the __sfdc_trigger entry point),
    // so scan the whole line rather than only the last pipe-field.
    const m = line.match(/\b([A-Za-z_][A-Za-z0-9_]*)\s+on\s+\w+\s+trigger event/); // "MyTrigger on Account trigger event ..."
    if (m) names.add(m[1]);
    const re = /(?:^|\|)([A-Za-z_][A-Za-z0-9_]*)\.[A-Za-z_]/g;                     // Class.method / Class.Class(
    let mm;
    while ((mm = re.exec(line)) !== null) names.add(mm[1]);
  }
  return [...names].filter((n) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n) && n.length > 1).slice(0, 15);
}

// SOQL Query Plan (read-only ?explain=).
async function getQueryPlan(apiHost, soql) {
  const s = await getSession(apiHost);
  const res = await rawFetch(s, `/services/data/v${s.apiVersion}/query/?explain=${encodeURIComponent(soql)}`);
  return (await res.json()).plans || [];
}

// Resolve a user by Id, Name, or Username.
async function resolveUser(apiHost, term) {
  const s = await getSession(apiHost);
  const t = String(term || "").trim();
  let where;
  if (/^005[0-9A-Za-z]{12,15}$/.test(t)) where = `Id='${t}'`;
  else { const lit = soqlLiteral(t); where = `Name='${lit}' OR Username='${lit}' OR Username LIKE '${lit}%'`; }
  return restQuery(s, `SELECT Id, Name, Username, IsActive, UserType, Profile.Name FROM User WHERE ${where} LIMIT 5`);
}

// A user's permission picture: profile, permission sets, notable system perms,
// and (if a specific object is named) that object's CRUD across their perm sets.
async function getUserPermissions(apiHost, userId, sobject) {
  const s = await getSession(apiHost);
  const psa = await restQuery(s,
    `SELECT PermissionSet.Label, PermissionSet.Name, PermissionSet.IsOwnedByProfile, PermissionSet.Profile.Name, ` +
    `PermissionSet.PermissionsModifyAllData, PermissionSet.PermissionsViewAllData, PermissionSet.PermissionsApiEnabled, ` +
    `PermissionSet.PermissionsViewSetup, PermissionSet.PermissionsAuthorApex ` +
    `FROM PermissionSetAssignment WHERE AssigneeId='${soqlLiteral(userId)}'`);
  const result = { profile: null, permissionSets: [], systemPerms: {}, objectAccess: null };
  const flags = ["ModifyAllData", "ViewAllData", "ApiEnabled", "ViewSetup", "AuthorApex"];
  for (const a of psa) {
    const ps = a.PermissionSet || {};
    if (ps.IsOwnedByProfile) result.profile = (ps.Profile && ps.Profile.Name) || result.profile;
    else if (ps.Label || ps.Name) result.permissionSets.push(ps.Label || ps.Name);
    for (const f of flags) if (ps["Permissions" + f]) result.systemPerms[f] = true;
  }
  if (sobject && /^[A-Za-z][A-Za-z0-9_]*$/.test(sobject)) {
    try {
      result.objectAccess = {
        sobject,
        grants: await restQuery(s,
          `SELECT Parent.Label, PermissionsRead, PermissionsCreate, PermissionsEdit, PermissionsDelete, ` +
          `PermissionsViewAllRecords, PermissionsModifyAllRecords FROM ObjectPermissions ` +
          `WHERE SobjectType='${soqlLiteral(sobject)}' AND ParentId IN ` +
          `(SELECT PermissionSetId FROM PermissionSetAssignment WHERE AssigneeId='${soqlLiteral(userId)}')`),
      };
    } catch (e) { result.objectAccess = { sobject, error: e.message }; }
  }
  return result;
}

// Heuristic: an sobject name mentioned in a question ("Account", "My_Obj__c").
function detectSobject(q) {
  const cm = String(q).match(/\b([A-Za-z][A-Za-z0-9_]*__c)\b/i);
  if (cm) return cm[1];
  const known = ["Account", "Contact", "Opportunity", "Lead", "Case", "User", "Order", "Product2", "Quote", "Contract", "Campaign", "Task", "Event", "Asset"];
  for (const k of known) if (new RegExp(`\\b${k}\\b`).test(q)) return k;
  return null;
}

// Auto-fetch (read-only) the org data a chat question needs — SOQL query plans
// and/or a user's permissions — and format it as extra context. Lets the
// zero-key CLI path answer "what's the query plan…" / "why can't user X…"
// using real org data without any live tool-calling.
async function enrichForChat(apiHost, question, logText) {
  if (!apiHost || !question) return "";
  const q = String(question).toLowerCase();
  const blocks = [];
  if (/query plan|selectiv|\bindex(es)?\b|\bexplain\b|cardinalit|full( table)? scan|table scan|slow quer/.test(q)) {
    const queries = extractSoql(logText);
    const plans = [];
    for (const soql of queries.slice(0, 6)) {
      try { plans.push({ soql, plans: await getQueryPlan(apiHost, soql) }); }
      catch (e) { plans.push({ soql, error: e.message }); }
    }
    if (plans.length) blocks.push("SOQL Query Plan results (read-only, Salesforce Query Plan API):\n" + JSON.stringify(plans, null, 2));
    else if (/query plan/.test(q)) blocks.push("No SOQL_EXECUTE_BEGIN queries were found in the log(s) to run a query plan on.");
  }
  if (/permission|access|profile|perm ?set|\bfls\b|field[ -]level|sharing|who ran|running user|which user|what user|user (context|ran|who)|\bran (this|the)\b|can'?t |cannot |couldn'?t |unable to|\bcrud\b|modify all|view all/.test(q)) {
    let target = null;
    const m = question.match(/([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|005[0-9A-Za-z]{12,15})/);
    if (m) target = m[1];
    if (!target) { const ru = extractRunningUser(logText); if (ru) target = ru.id; }
    if (target) {
      try {
        const users = await resolveUser(apiHost, target);
        if (users.length) {
          const u = users[0];
          const perms = await getUserPermissions(apiHost, u.Id, detectSobject(question));
          blocks.push(`Permission/access data (read-only) for ${u.Name} <${u.Username}> — profile "${(u.Profile && u.Profile.Name) || "?"}", active=${u.IsActive}:\n` + JSON.stringify(perms, null, 2));
        } else blocks.push(`No Salesforce user matched "${target}".`);
      } catch (e) { blocks.push(`Could not fetch permissions: ${e.message}`); }
    }
  }
  if (!blocks.length) return "";
  return "\n\nLive read-only data fetched from the org to answer this (authoritative — prefer it over guessing):\n\n" + blocks.join("\n\n");
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

If multiple logs are provided (separated by "===== LOG … =====" markers), analyze them together as one operation: cover each where relevant and call out patterns or causes that span the logs.

Be precise, reference concrete values from the log, and use Markdown.`;

// Follow-up / chat mode: answer the user's question directly instead of
// emitting the fixed report template above.
const CLAUDE_CHAT_SYSTEM = `You are an expert Salesforce developer helping someone understand Apex debug logs.
Answer the user's question directly and conversationally, in plain prose.
Do NOT produce a fixed report with headed sections (Summary / Errors / Governor Limits / etc.) — just answer what was asked.
Be concise and specific: reference concrete values, line numbers, method names, and limits straight from the log(s). Use Markdown for emphasis/code where helpful.
When multiple logs are provided (separated by "===== LOG … =====" markers), consider all of them and say which log something came from when it matters.`;

// Compare two groups of logs (each group may be several logs forming one operation).
const CLAUDE_COMPARE_SYSTEM = `You are an expert Salesforce developer comparing two sets of Apex debug logs.
Each set may contain MULTIPLE logs that together form ONE continuous operation (e.g. a save that cascades into several transactions), so read all logs in a group as a whole.
GROUP A is the baseline; GROUP B is the comparison (e.g. before vs after a change, or a passing vs failing run).
Produce a focused DIFF in Markdown with these sections (omit any that don't apply):

## Verdict
One or two sentences: what materially changed between A and B.

## What Changed
Concrete differences: SOQL/DML counts and which queries appeared/disappeared, methods added/removed, CPU/heap/limit deltas, new or resolved exceptions. Prefer an A-vs-B table.

## Regressions / Improvements
Anything that got worse (more queries, slower, new errors) or better.

## Likely Cause & Recommendations
The most likely reason for the differences and specific next steps.

Reference concrete values from the logs. Do not invent data that isn't in them.`;

// Static code review of the Apex that ran in a log.
const CLAUDE_CODEHEALTH_SYSTEM = `You are a senior Salesforce engineer doing a focused code review of Apex that executed in a debug log.
You are given the source of the Apex classes/triggers involved. Report only real, high-impact issues:
- SOQL or DML inside loops / missing bulkification
- Missing CRUD/FLS checks (isAccessible/isUpdateable, stripInaccessible, "with sharing")
- Hardcoded IDs or org-specific values
- Unbounded queries, missing LIMIT, non-selective filters
- Empty catch blocks / swallowed exceptions, poor error handling
- Recursion / trigger re-entrancy risks

Use Markdown. For each finding give: severity (High/Medium/Low), the class + approximate location, the problem, and a concrete fix. Rank most severe first. If the code looks healthy, say so briefly. Do not invent code that isn't shown.`;

// Order-of-execution / "what fires on save" for an object.
const CLAUDE_ONSAVE_SYSTEM = `You are a Salesforce expert explaining what automation fires when a record of a given object is saved.
You are given the object's active triggers (with before/after events), record-triggered flows (with trigger type + order), validation rules, and workflow rules — all read from the org.
Lay out the Salesforce Order of Execution for a save on this object, in order, showing which of THIS object's automations run at each step (before-save flows, before triggers, validation rules, duplicate rules, after triggers, assignment/auto-response/workflow, after-save flows, roll-up summaries, etc.).
Then flag risks: multiple automations writing the same field, ambiguous flow ordering, before vs after conflicts, recursion risk. Use Markdown. Only reference automations present in the provided data.`;

// Ranked root-cause analysis over a STRUCTURED DIGEST (extracted client-side
// from the whole log), so we reason over full signal instead of a truncated
// head+tail slice of raw text.
const CLAUDE_DIAGNOSE_SYSTEM = `You are an expert Salesforce engineer performing root-cause analysis on an Apex transaction.
You are given a STRUCTURED DIGEST already extracted from the FULL debug log (governor limits, a SOQL inventory with repeat counts, DML, exceptions, the slowest operations, and pre-computed deterministic findings). Treat it as complete and authoritative — it is NOT truncated.
Produce a RANKED list of probable root causes, most likely first. For each:
- **Cause** — one line.
- **Confidence** — High / Medium / Low.
- **Evidence** — cite concrete values from the digest (counts, ms, limits, query text, exception messages).
- **Fix** — a specific, actionable change.
- **How to confirm** — the quickest way to validate it.
Start with a one-sentence verdict. If nothing is wrong, say the transaction looks healthy and why. Use Markdown. Do not invent data not present in the digest.`;

const MAX_LOG_CHARS = 160000;
function truncateLog(body, limit = MAX_LOG_CHARS) {
  if (body.length <= limit) return { text: body, truncated: false };
  const head = Math.floor(limit * 0.55);
  const tail = limit - head;
  return {
    text: body.slice(0, head) + `\n\n... [${body.length - limit} characters trimmed] ...\n\n` + body.slice(body.length - tail),
    truncated: true,
  };
}
async function analyzeViaApi(apiKey, system, userContent) {
  traceHttp("POST", "https://api.anthropic.com/v1/messages");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: getModel(), max_tokens: 3000, system, messages: [{ role: "user", content: userContent }] }),
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

// Locate the Claude Code CLI. A GUI-launched .app gets a minimal PATH (no
// ~/.local/bin, Homebrew, etc.), so `claude` isn't found there even though it
// works from a Terminal. Check the usual install locations, then fall back to
// PATH resolution.
let cachedClaude = null;
function resolveClaude() {
  if (cachedClaude) return cachedClaude;
  const home = os.homedir();
  const candidates = [
    process.env.CLAUDE_CLI,
    path.join(home, ".claude", "local", "claude"),
    path.join(home, ".local", "bin", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    path.join(home, ".npm-global", "bin", "claude"),
    path.join(home, "bin", "claude"),
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (fs.existsSync(c)) { cachedClaude = c; return c; } } catch { /* ignore */ }
  }
  cachedClaude = "claude"; // let execFile try PATH (works when launched from a shell)
  return cachedClaude;
}

// Zero-key path: use the locally installed Claude Code CLI (`claude -p`), which
// runs under the user's existing login. The instruction is the -p arg; the
// (large) log is piped via stdin — the documented `cat file | claude -p` form.
function analyzeViaCli(instruction, stdinText) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      resolveClaude(),
      ["-p", instruction, "--model", cliModelArg()],
      { maxBuffer: 32 * 1024 * 1024, timeout: 240000 },
      (err, stdout, stderr) => {
        if (err) {
          if (err.code === "ENOENT") {
            return reject(new Error("Claude Code CLI ('claude') not found. Install it (claude.ai/code), or set an ANTHROPIC_API_KEY env var / ~/.apex-log-analyzer.json."));
          }
          return reject(new Error(String(stderr || err.message || "claude CLI failed").slice(0, 400)));
        }
        resolve(String(stdout || "").trim());
      }
    );
    child.stdin.end(stdinText);
  });
}

// Render prior turns of a follow-up conversation as plain text.
function renderHistory(history) {
  if (!Array.isArray(history) || !history.length) return "";
  let s = "\n\nConversation so far:\n";
  for (const h of history) {
    const who = h && h.role === "assistant" ? "Assistant" : "User";
    const t = String((h && h.text) || "").slice(0, 8000);
    if (t) s += `\n${who}: ${t}\n`;
  }
  return s;
}

async function analyze({ apiHost, id, question, logText, freeform, history }) {
  // logText is supplied directly by the client for uploaded files and for
  // multi-log ("analyze selected") requests; otherwise fetch the one log by id.
  const body = (logText != null && logText !== "") ? String(logText) : await getLogBody(apiHost, id);
  const { text, truncated } = truncateLog(body);
  const truncNote = truncated ? "\nNote: the log(s) were trimmed (head + tail kept) because they are large." : "";
  const apiKey = getApiKey();

  if (freeform) {
    // Follow-up question: answer directly, with the logs + prior turns as context.
    // Auto-fetch (read-only) any query-plan / permission data the question needs.
    const priorTurns = renderHistory(history);
    const enrichment = await enrichForChat(apiHost, question, text);
    if (apiKey) {
      const userContent =
        "Here are the Apex debug log(s):\n\n```\n" + text + "\n```\n" +
        (truncated ? "\n(Trimmed because large.)\n" : "") +
        priorTurns + enrichment +
        `\n\nMy question: ${question || "Explain these logs."}`;
      return analyzeViaApi(apiKey, CLAUDE_CHAT_SYSTEM, userContent);
    }
    const instruction =
      CLAUDE_CHAT_SYSTEM +
      priorTurns + enrichment +
      truncNote +
      `\n\nMy question: ${question || "Explain these logs."}` +
      "\n\nThe raw Apex debug log(s) are on standard input. Do not use any tools; just answer using the log text and the data above.";
    return analyzeViaCli(instruction, text);
  }

  if (apiKey) {
    const userContent =
      (question ? `The user is specifically asking: "${question}"\n\n` : "") +
      (truncated ? "Note: this log was trimmed (head + tail kept) because it is large.\n\n" : "") +
      "Here is the Apex debug log:\n\n```\n" + text + "\n```";
    return analyzeViaApi(apiKey, CLAUDE_SYSTEM, userContent);
  }
  // No key configured -> use the local Claude Code CLI (no manual step).
  const instruction =
    CLAUDE_SYSTEM +
    (question ? `\n\nThe user is specifically asking: "${question}"` : "") +
    truncNote +
    "\n\nThe raw Apex debug log to analyze is provided on standard input. Do not use any tools; just analyze the log text.";
  return analyzeViaCli(instruction, text);
}

// Run a system prompt over a block of user content, via API key or the CLI.
async function runClaude(system, userContent, cliTail) {
  const apiKey = getApiKey();
  if (apiKey) return analyzeViaApi(apiKey, system, userContent);
  return analyzeViaCli(system + cliTail, userContent);
}

// --- Salesforce knowledge search across MCP servers -----------------------
// The operator's Claude Code install may have Slack / OrgCS / GUS MCP servers
// connected. When enabled we let `claude -p` call ONLY their read/search tools
// (allow-listed below — never a write tool) to look up prior art on the errors
// found in the selected log(s). `listName` is exactly what `claude mcp list`
// prints for that server so we can read its connection status.
const SF_MCP = [
  {
    key: "orgcs", label: "OrgCS (Salesforce cases/records)", listName: "orgcs",
    tools: [
      "mcp__orgcs__soqlQuery", "mcp__orgcs__find", "mcp__orgcs__getRelatedRecords",
      "mcp__orgcs__getObjectSchema", "mcp__orgcs__getUserInfo", "mcp__orgcs__listRecentSobjectRecords",
    ],
    hint: "Search Cases (and related records) for the same/similar errors and note the Case number + how each was resolved.",
  },
  {
    key: "slack", label: "Slack", listName: "slack",
    tools: [
      "mcp__slack__slack_search_public", "mcp__slack__slack_search_public_and_private",
      "mcp__slack__slack_search_channels", "mcp__slack__slack_search_users",
      "mcp__slack__slack_read_thread", "mcp__slack__slack_read_channel",
      "mcp__slack__slack_read_user_profile", "mcp__slack__slack_list_user_channels",
      "mcp__slack__slack_read_canvas", "mcp__slack__slack_read_list", "mcp__slack__slack_get_reactions",
    ],
    hint: "Search channels/threads for discussions of the same/similar errors and summarize the resolution reached, with a link to the thread.",
  },
  {
    key: "gus", label: "GUS (work items / bugs)", listName: "plugin:gus:gus_server",
    tools: [
      "mcp__plugin_gus_gus_server__query_gus_records",
      "mcp__plugin_gus_gus_server__query_gus_chatter",
      "mcp__plugin_gus_gus_server__get_object_description",
    ],
    hint: "Search work items / bugs for the same/similar errors. For each relevant work item, ALSO read its Chatter/discussion feed (query_gus_chatter) — the actual root cause, workaround, and fix are usually in the discussion thread, not the work-item fields. Report the work-item number (W-#####), its status, and the resolution/known-issue drawn from BOTH the record AND its discussion.",
  },
];

// `claude mcp list` health -> which of the three servers are connected.
// One probe run of `claude mcp list`, parsed per server.
function probeMcpOnce() {
  return new Promise((resolve) => {
    execFile(resolveClaude(), ["mcp", "list"], { timeout: 60000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      const lines = String(stdout || "").split("\n");
      const servers = SF_MCP.map((m) => {
        const line = lines.find((l) => l.trimStart().startsWith(m.listName + ":")) || "";
        // A connected server prints a check + "Connected"; a failed one prints ✗ / "Failed".
        const connected = /connected/i.test(line) && !/fail|✗|✘/i.test(line);
        return { key: m.key, label: m.label, connected };
      });
      resolve(servers);
    });
  });
}

let mcpStatusCache = { at: 0, servers: null };
async function mcpStatus(force = false) {
  const now = Date.now();
  // Fully-connected results are stable — cache 30s. A partial/failed probe is
  // often a transient timeout (the OrgCS HTTP endpoint probes slower than the
  // others), so cache it only briefly so it self-heals on the next open.
  if (!force && mcpStatusCache.servers) {
    const ttl = mcpStatusCache.servers.every((s) => s.connected) ? 30000 : 4000;
    if (now - mcpStatusCache.at < ttl) return mcpStatusCache.servers;
  }
  let servers = await probeMcpOnce();
  // If anything looks down, probe once more before trusting it — the health
  // check flakes on slower remote (HTTP) servers, and a false "not connected"
  // is worse than a small delay.
  if (!servers.every((s) => s.connected)) {
    const retry = await probeMcpOnce();
    // Union: a server counts as connected if EITHER probe saw it connected.
    servers = servers.map((s) => {
      const r = retry.find((x) => x.key === s.key);
      return { ...s, connected: s.connected || (r && r.connected) };
    });
  }
  mcpStatusCache = { at: Date.now(), servers };
  return servers;
}

// Run `claude -p` allowing a specific set of (read-only) MCP tools. Longer
// timeout than a plain analysis because agentic MCP search does several round
// trips. The error context is piped on stdin.
function runClaudeWithTools(instruction, stdinText, allowedTools, timeoutMs) {
  return new Promise((resolve, reject) => {
    const args = ["-p", instruction, "--model", cliModelArg()];
    if (allowedTools && allowedTools.length) args.push("--allowedTools", allowedTools.join(","));
    const child = execFile(
      resolveClaude(), args,
      { maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs || 540000 },
      (err, stdout, stderr) => {
        if (err) {
          if (err.code === "ENOENT") return reject(new Error("Claude Code CLI ('claude') not found."));
          if (err.killed) return reject(new Error("The Salesforce knowledge search timed out. Try fewer logs or fewer MCP servers."));
          return reject(new Error(String(stderr || err.message || "claude CLI failed").slice(0, 500)));
        }
        resolve(String(stdout || "").trim());
      }
    );
    child.stdin.end(stdinText || "");
  });
}

// One focused agent PER source. They run in PARALLEL (each allowed ONLY its own
// source's read tools), so the three searches overlap instead of a single agent
// hopping between all three servers serially. Each is told to search a few broad
// angles and then STOP, so no one source runs away with the clock.
function sfSourceSystem(source, hint) {
  return (
`You are a Salesforce support research assistant searching ONE knowledge source: ${source}.
You are given the errors found in one or more Apex debug logs (on standard input). Find PRIOR ART for those errors in ${source} ONLY.

Your task for this source: ${hint}

Method — broad but FAST:
- For EACH distinct error run a FEW (about 2-4) broad searches: the exception type alone, key phrases from the message, the failing object/field/DML operation, and the underlying cause — NOT just the verbatim string (exact match misses related work).
- Judge relevance, keep the strongest matches, then STOP. Do not over-search or chase weak leads.
- Everything must be READ-ONLY. Never post, create, update, or message anything.

Output COMPACT Markdown findings for THIS source only — no preamble:
- One bullet per relevant match: the identifier (Case number / GUS work-item number / Slack #channel + date), a one-line summary, and the resolution/outcome if known.
- For any error with no relevant match: "- No relevant matches for: <error>".
- Do NOT write an overall summary or a suggested resolution — a later step does that. Never invent identifiers or resolutions; report only what the tools actually returned.`
  );
}

// Fast, tool-free consolidation pass. It reads OUR actual log plus the parallel
// source findings, cross-checks the findings against each other, and then tells
// us what to fix in OUR scenario — not just what prior cases did.
const SF_SYNTH_SYSTEM =
`You are a senior Salesforce support/dev engineer helping fix a LIVE issue. You are given:
1) The extracted errors and the ACTUAL Apex debug log(s) from the user's own scenario (on standard input, under "OUR SCENARIO").
2) Research findings gathered IN PARALLEL from up to three knowledge sources (OrgCS cases, Slack discussions, GUS work items) about the same/similar errors, under "PRIOR ART".

Your job is to REVIEW OUR LOG and tell the user concretely what to do to fix THIS issue in THEIR org/code — using the prior art as supporting evidence, not as the answer itself.

First read our log: identify the actual failing point — the exception/fatal line, the Apex class/method/trigger and line, the object/field/DML/SOQL/limit involved, and the likely root cause in THIS scenario.

Cross-check the prior art: when findings from different sources point at the same underlying issue (e.g. a Slack thread names a Case or GUS work item another source also surfaced), link them and treat the corroboration as higher confidence. Note anything that clearly matches — or clearly does NOT match — our scenario.

Output (Markdown):
- "## What went wrong" — the root cause in our log, in plain terms, citing the specific line/class/method/object from OUR log.
- "## How to fix it (our scenario)" — concrete, ordered steps for THIS case: what to change (code/config/data), what to check, and any workaround. Be specific to what our log shows, not generic advice.
- "## Prior art" — the supporting evidence: cite Case numbers, GUS work-item numbers (W-#####), and Slack #channel/threads, each with its resolution. If a discussion had NO case/work-item number, say so and give the resolution reached. If a source found nothing relevant, say so briefly.
- "## Confidence & caveats" — how sure you are and what to verify.
Be concrete and factual. Only cite identifiers/resolutions that appear in the findings; never invent them. Ground the fix in what OUR log actually shows.`;

async function sfAnalyze({ enabled, context, logText }) {
  const keys = Array.isArray(enabled) ? enabled : [];
  const servers = SF_MCP.filter((m) => keys.includes(m.key));
  if (!servers.length) throw new Error("Enable at least one connected MCP server (Slack, OrgCS or GUS) for the search.");
  const ctx = String(context || "").trim();
  if (!ctx) throw new Error("No errors were extracted from the selected log(s) to research.");
  // Guard: only allow servers that are actually connected right now.
  const live = new Set((await mcpStatus()).filter((s) => s.connected).map((s) => s.key));
  const usable = servers.filter((m) => live.has(m.key));
  if (!usable.length) throw new Error("None of the enabled MCP servers are currently connected. Authenticate them in Claude Code first.");

  // Fan out: one focused agent per source, all at once. A shorter per-source
  // timeout means one slow/hung source degrades to a note instead of stalling
  // the whole run — the others' findings still come back.
  const PER_SOURCE_TIMEOUT = 240000;
  const results = await Promise.all(
    usable.map(async (m) => {
      const instruction = sfSourceSystem(m.label, m.hint) +
        "\n\nThe extracted errors / log context to research are on standard input.";
      try {
        const text = await runClaudeWithTools(instruction, ctx, m.tools, PER_SOURCE_TIMEOUT);
        return { label: m.label, text: text || "(no findings returned)", ok: true };
      } catch (e) {
        return { label: m.label, text: `(search failed: ${e.message})`, ok: false };
      }
    })
  );

  // Consolidate + cross-check in one fast tool-free pass.
  const findingsBlock = results
    .map((r) => `### Findings from ${r.label}\n${r.text}`)
    .join("\n\n");
  // Give the synthesis pass OUR actual log (trimmed if large) so it can review
  // this specific scenario and produce a concrete fix, not just echo prior art.
  const logRaw = String(logText || "").trim();
  const { text: ourLog, truncated } = logRaw ? truncateLog(logRaw) : { text: "", truncated: false };
  const scenario =
    `Extracted errors:\n${ctx}` +
    (ourLog ? `\n\nActual Apex debug log(s)${truncated ? " (trimmed — head + tail kept)" : ""}:\n\`\`\`\n${ourLog}\n\`\`\`` : "");
  const synthInput =
    `=== OUR SCENARIO ===\n${scenario}\n\n=== PRIOR ART (parallel source findings) ===\n\n${findingsBlock}`;
  const report = await runClaude(SF_SYNTH_SYSTEM, synthInput, "\n\nOUR SCENARIO (our log + errors) and the PRIOR ART findings are on standard input. Do not use any tools; reason over the provided text.");

  const failed = results.filter((r) => !r.ok).map((r) => r.label);
  const note = failed.length
    ? `\n\n---\n_Note: ${failed.join(", ")} did not respond in time; the above reflects the sources that did._`
    : "";
  return report + note;
}

// #9 Compare — two groups of logs (each group may span several logs). The
// client sends structured digests (full-signal, not truncated) when available;
// we fall back to raw text for older callers.
async function compareLogs({ groupA, groupB, digestA, digestB }) {
  if (digestA != null || digestB != null) {
    const userContent =
      "GROUP A (baseline) — structured digest:\n\n" + String(digestA || "") + "\n\n" +
      "GROUP B (comparison) — structured digest:\n\n" + String(digestB || "");
    return runClaude(CLAUDE_COMPARE_SYSTEM, userContent,
      "\n\nTwo structured digests are on standard input (GROUP A then GROUP B). Do not use any tools; compare them.");
  }
  const half = Math.floor(MAX_LOG_CHARS / 2);
  const a = truncateLog(String(groupA || ""), half);
  const b = truncateLog(String(groupB || ""), half);
  const userContent =
    "GROUP A (baseline):\n\n```\n" + a.text + "\n```\n\n" +
    "GROUP B (comparison):\n\n```\n" + b.text + "\n```";
  return runClaude(CLAUDE_COMPARE_SYSTEM, userContent,
    "\n\nThe two log groups are on standard input (GROUP A then GROUP B). Do not use any tools; just compare them.");
}

// #5 Diagnose — ranked root causes from a structured digest.
async function diagnoseLog({ digest }) {
  if (!digest) throw new Error("No digest provided to diagnose.");
  return runClaude(CLAUDE_DIAGNOSE_SYSTEM, "Structured digest of the Apex log:\n\n" + String(digest),
    "\n\nThe structured digest is on standard input. Do not use any tools; base your analysis only on it.");
}

// #11 Code Health — review the Apex source that ran in the given log(s).
async function codeHealth({ apiHost, logText }) {
  const names = extractApexUnits(logText);
  if (!names.length) throw new Error("No Apex classes or triggers were found executing in this log.");
  if (!apiHost) throw new Error("Select a Salesforce org so the Apex source can be fetched for review.");
  const s = await getSession(apiHost);
  const inList = names.map((n) => `'${n}'`).join(","); // names are validated identifiers
  const sources = [];
  for (const r of await toolingQuery(s, `SELECT Name, Body FROM ApexClass WHERE Name IN (${inList})`)) sources.push({ type: "class", name: r.Name, body: r.Body });
  for (const r of await toolingQuery(s, `SELECT Name, Body FROM ApexTrigger WHERE Name IN (${inList})`)) sources.push({ type: "trigger", name: r.Name, body: r.Body });
  if (!sources.length) throw new Error(`Could not fetch readable source for: ${names.join(", ")} (managed/namespaced code has no readable Body).`);
  const perBudget = Math.max(2000, Math.floor(MAX_LOG_CHARS / sources.length));
  const userContent = sources
    .map((x) => `===== ${x.type.toUpperCase()}: ${x.name} =====\n` + truncateLog(String(x.body || ""), perBudget).text)
    .join("\n\n");
  const text = await runClaude(CLAUDE_CODEHEALTH_SYSTEM, userContent,
    "\n\nThe Apex source is on standard input. Do not use any tools; just review it.");
  return { names, reviewed: sources.map((x) => x.name), text };
}

// #12 On Save — list triggerable objects, and the automation that fires on save.
async function listObjects(apiHost) {
  const s = await getSession(apiHost);
  const res = await rawFetch(s, `/services/data/v${s.apiVersion}/sobjects/`);
  const all = (await res.json()).sobjects || [];
  return all
    .filter((o) => o.triggerable && o.queryable && !o.deprecatedAndHidden)
    .map((o) => ({ name: o.name, label: o.label }))
    .sort((x, y) => x.label.localeCompare(y.label));
}
async function onSave({ apiHost, sobject }) {
  if (!apiHost) throw new Error("Select a Salesforce org first.");
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(String(sobject || ""))) throw new Error("Invalid object name.");
  const s = await getSession(apiHost);
  const lit = soqlLiteral(sobject);
  const data = { sobject, triggers: [], validationRules: [], flows: [], workflowRules: [] };
  // Each query is wrapped so one unsupported field/object doesn't sink the rest.
  try {
    data.triggers = await toolingQuery(s,
      `SELECT Name, Status, UsageBeforeInsert, UsageAfterInsert, UsageBeforeUpdate, UsageAfterUpdate, ` +
      `UsageBeforeDelete, UsageAfterDelete, UsageAfterUndelete FROM ApexTrigger WHERE TableEnumOrId='${lit}'`);
  } catch (e) { data.triggersError = e.message; }
  try {
    data.validationRules = await toolingQuery(s,
      `SELECT ValidationName, Active, ErrorMessage FROM ValidationRule WHERE EntityDefinition.QualifiedApiName='${lit}'`);
  } catch (e) { data.validationRulesError = e.message; }
  try {
    data.flows = await restQuery(s,
      `SELECT Label, ProcessType, TriggerType, TriggerOrder, RecordTriggerType FROM FlowDefinitionView ` +
      `WHERE TriggerObjectOrEvent='${lit}' AND IsActive=true`);
  } catch (e) { data.flowsError = e.message; }
  try {
    data.workflowRules = await toolingQuery(s, `SELECT Name, Active FROM WorkflowRule WHERE TableEnumOrId='${lit}'`);
  } catch (e) { data.workflowRulesError = e.message; }
  const userContent = `Object: ${sobject}\n\nAutomation data from the org (JSON):\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\``;
  const text = await runClaude(CLAUDE_ONSAVE_SYSTEM, userContent,
    "\n\nThe automation data (JSON) is on standard input. Do not use any tools.");
  return { data, text };
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
  // Local dev tool: never let the browser serve a stale app.css / app.js / app.html,
  // so edits show up on a normal reload (no Cmd+Shift+R needed).
  res.writeHead(200, {
    "Content-Type": MIME[path.extname(full)] || "text/plain",
    "Cache-Control": "no-cache, no-store, must-revalidate",
  });
  fs.createReadStream(full).pipe(res);
}

// The server binds to loopback, but a browser can still reach it from ANY page
// the user visits. Two guards close that off:
//  - Host must be a loopback literal — defeats DNS-rebinding (an attacker domain
//    that rebinds to 127.0.0.1 still sends its own name in the Host header).
//  - Origin (when present) must be loopback too — defeats cross-site fetch/CSRF
//    from a normal malicious page (which sends its real Origin).
// Same-origin navigations and the app's own relative fetches pass cleanly.
function isLoopbackName(name) {
  const n = String(name || "").toLowerCase().replace(/^\[|\]$/g, "");
  return n === "localhost" || n === "127.0.0.1" || n === "::1";
}
function requestIsLocal(req) {
  const host = (req.headers.host || "").toLowerCase().replace(/:\d+$/, "");
  if (!isLoopbackName(host)) return false;
  const origin = req.headers.origin;
  if (origin) {
    try { if (!isLoopbackName(new URL(origin).hostname)) return false; } catch { return false; }
  }
  return true;
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  const p = u.pathname;
  if (!requestIsLocal(req)) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    return res.end("Forbidden: this app only accepts requests from your own machine.");
  }
  try {
    if (!p.startsWith("/api/")) return serveStatic(res, p);
    if (p === "/api/ping") return sendJson(res, 200, { app: "apex-log-analyzer" });
    // Browser lifecycle: the page beats every few seconds; on tab close it sends
    // a "bye" beacon and we exit shortly after — but a heartbeat (e.g. from a
    // page reload) within the grace window cancels the shutdown.
    if (p === "/api/heartbeat") {
      if (pendingQuit) { clearTimeout(pendingQuit); pendingQuit = null; }
      return sendJson(res, 200, { ok: true });
    }
    if (p === "/api/bye") {
      if (pendingQuit) clearTimeout(pendingQuit);
      pendingQuit = setTimeout(() => { console.log("Browser closed — shutting down."); process.exit(0); }, 4000);
      return sendJson(res, 200, { ok: true });
    }
    if (p === "/api/orgs") return sendJson(res, 200, { orgs: await listOrgsForUi(u.searchParams.get("fresh") === "1") });
    if (p === "/api/whoami") return sendJson(res, 200, await whoami(u.searchParams.get("org")));
    if (p === "/api/mcp-status") return sendJson(res, 200, { servers: await mcpStatus(u.searchParams.get("fresh") === "1") });
    if (p === "/api/sf-analyze" && req.method === "POST") {
      const { enabled, context, logText } = await readBody(req);
      return sendJson(res, 200, { text: await sfAnalyze({ enabled, context, logText }) });
    }
    if (p === "/api/diag") return sendJson(res, 200, diagnose());
    if (p === "/api/logs") return sendJson(res, 200, { records: await listLogs(u.searchParams.get("org"), u.searchParams.get("mins")) });
    if (p === "/api/search") return sendJson(res, 200, { matches: await searchLogs(u.searchParams.get("org"), u.searchParams.get("q") || "") });
    if (p === "/api/logbody") {
      const body = await getLogBody(u.searchParams.get("org"), u.searchParams.get("id"));
      res.writeHead(200, { "Content-Type": "text/plain" }); return res.end(body);
    }
    if (p === "/api/analyze" && req.method === "POST") {
      const { org, id, question, logText, freeform, history } = await readBody(req);
      return sendJson(res, 200, { text: await analyze({ apiHost: org, id, question, logText, freeform, history }) });
    }
    if (p === "/api/compare" && req.method === "POST") {
      const { groupA, groupB, digestA, digestB } = await readBody(req);
      return sendJson(res, 200, { text: await compareLogs({ groupA, groupB, digestA, digestB }) });
    }
    if (p === "/api/diagnose" && req.method === "POST") {
      const { digest } = await readBody(req);
      return sendJson(res, 200, { text: await diagnoseLog({ digest }) });
    }
    if (p === "/api/codehealth" && req.method === "POST") {
      const { org, logText } = await readBody(req);
      return sendJson(res, 200, await codeHealth({ apiHost: org, logText }));
    }
    if (p === "/api/objects") return sendJson(res, 200, { objects: await listObjects(u.searchParams.get("org")) });
    if (p === "/api/onsave" && req.method === "POST") {
      const { org, sobject } = await readBody(req);
      return sendJson(res, 200, await onSave({ apiHost: org, sobject }));
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

// Is our app already answering on this port? (Used to avoid starting a second
// instance — which would open a second browser tab on a different port.)
function pingApp(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/api/ping", timeout: 300 }, (res) => {
      let d = ""; res.on("data", (c) => (d += c));
      res.on("end", () => { try { resolve(JSON.parse(d).app === "apex-log-analyzer"); } catch { resolve(false); } });
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

// Find and bind the first free port instead of relying on a fixed one: try the
// preferred port and the next several, and if they're all taken, fall back to
// an OS-assigned ephemeral port (0) so the app always starts on *some* port.
async function startServer(preferred) {
  const candidates = [];
  for (let i = 0; i < 20; i++) candidates.push(preferred + i);

  // Single instance: if a copy is already running, just open it and exit
  // instead of launching a duplicate server (which caused a second tab).
  for (const p of candidates) {
    if (await pingApp(p)) {
      const url = `http://localhost:${p}`;
      console.log(`\n  ⚡ Apex Log Analyzer is already running at  ${url}  — opening it.\n`);
      openBrowser(url);
      return process.exit(0);
    }
  }

  candidates.push(0); // last resort: let the OS pick any open port
  let idx = 0;

  const onError = (err) => {
    if (err.code === "EADDRINUSE" && idx < candidates.length - 1) {
      console.log(`  Port ${candidates[idx]} is in use — trying the next available port…`);
      idx++;
      server.listen(candidates[idx], "127.0.0.1");
    } else {
      console.error(`  Could not start server: ${err.message}`);
      process.exit(1);
    }
  };

  server.on("error", onError);
  server.once("listening", () => {
    server.removeListener("error", onError);
    const port = server.address().port;
    const url = `http://localhost:${port}`;
    console.log(`\n  ⚡ Apex Log Analyzer running at  ${url}\n`);
    console.log(`  Reading the Salesforce session from Chrome — just log into your org in Chrome.`);
    console.log(`  (macOS may show a one-time Keychain "Allow" prompt — click Always Allow.)`);
    console.log(`  Settings file: ${SETTINGS_PATH}`);
    if (!getApiKey()) console.log(`  Claude analysis uses your local "claude" CLI — no API key needed.\n`);
    openBrowser(url);
  });

  server.listen(candidates[idx], "127.0.0.1");
}
startServer(Number(PORT) || 8787);
