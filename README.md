# ⚡ Apex Log Analyzer

Capture, search, and **Claude-analyze** Salesforce Apex debug logs from a local
web app — with **zero manual setup**. It reads your Salesforce session straight
from Chrome (whatever org you're logged into just shows up) and auto-refreshes
the log list so new logs appear on their own.

> **Read-only:** the app only ever *reads* from your org (all Salesforce calls
> are HTTP GET — list logs + fetch log bodies). It does not create trace flags,
> debug levels, or any other records — manage debug logging yourself in
> **Setup → Debug Logs**.

- **No browser extension** (works even on MDM-managed Chrome).
- **No `sf` CLI login, no session pasting** — the session comes from Chrome.
- **No Anthropic API key** — analysis uses your local Claude Code CLI by default.
- Multiple logged-in orgs → pick one from a dropdown.
- Search **inside all captured log bodies**, plus per-log find.

> macOS only. Everything runs on your own machine — see **Privacy** below.

---

## What it can do

Beyond capture / search / analyze, the viewer and toolbar add developer tools —
all read-only, all powered by the same local Claude:

- **⏱ Performance Profile** — toggle any open log from **Raw** to **Profile** to see
  a timing breakdown (total & self time per method / trigger / SOQL / DML, slowest
  first) plus governor-limit usage bars (SOQL, DML, query rows, CPU…). **✨ Explain**
  hands the profile to Claude for a plain-language read.
- **Follow-up chat** — after an analysis, keep chatting with Claude about the same
  logs like a normal conversation. Two things happen automatically (no API key, no
  extra clicks): ask about a **SOQL query plan** and the app fetches the read-only
  `?explain=` plan for the queries in the log; ask about a **user's permissions**
  (the one who ran the transaction, or anyone you name) and it reads their profile,
  permission sets, and object CRUD/FLS — then Claude answers with that context.
- **⇄ Compare** — compare one set of logs against another (N-vs-M, since one save can
  fire several dependent logs). Pick the first group → **Next** → pick the second →
  **Compare**, and Claude reads both sides together to explain what changed.
- **🩺 Code Health** — reviews the Apex classes/triggers that actually ran in the
  selected log(s) — pulled read-only from the Tooling API — for bulkification, SOQL/DML
  in loops, missing null checks, and other issues.
- **🔀 On Save** — pick an object and see the full **order of execution**: triggers,
  validation rules, flows, and workflow rules that fire when a record is saved.

---

## Run it — nothing to install

1. Have **Google Chrome** open and logged into a Salesforce org.
2. Double-click **`Apex Log Analyzer.app`**.

That's it — no Terminal window. The first run quietly sets up a private Node
runtime (one-time, ~30 MB, into `~/Library/Application Support/Apex Log Analyzer`)
if your Mac doesn't already have a recent Node, then opens the app in your
browser on a free local port. No Node install, no `npm install` (the tool has
zero dependencies), no configuration. Quit the app to stop the server.

> **Gatekeeper note:** the app is unsigned, so the first time macOS may say
> *"Apple could not verify … is free of malware."* Click **Done** (not "Move to
> Trash"), then open **System Settings → Privacy & Security**, scroll down, and
> click **"Open Anyway"**. After that, double-click works normally.
>
> Prefer Terminal? `xattr -r -d com.apple.quarantine "/path/to/Apex Log Analyzer.app"`
> clears it in one go.

### For developers

Build the `.app` from source, or run the server directly (needs **Node 24 / 22.13+**):

```bash
./build-app.sh     # -> dist/Apex Log Analyzer.app  + ~/Apex Log Analyzer.zip
npm start          # == node server.js  (runs the server in this Terminal)
```

---

## First run: the Keychain prompt

The very first time, macOS asks whether this process may read the
**"Chrome Safe Storage"** Keychain item (that's Chrome's cookie-encryption key,
which the tool needs to read your Salesforce session). Click **Always Allow** so
you're not asked again. Nothing leaves your machine.

## Claude analysis

Analysis works out of the box if you have the **Claude Code CLI** (`claude`)
installed and logged in — the tool shells out to it, so no API key is needed.

Prefer the Anthropic API? Set an `ANTHROPIC_API_KEY` environment variable (or put
`{"apiKey":"…"}` in `~/.apex-log-analyzer.json`). Keys stay only in that file on
your machine (mode `600`). Pick the model from the **Model** dropdown in the toolbar.

Click a log (or tick several) and use the **✨ Analyze** button — it targets the
open log, or every ticked log ("Analyze N logs"). Then ask **follow-up questions**
in the chat box at the bottom of the analysis panel — follow-ups answer
conversationally over the same logs.

---

## How it works

- `server.js` — zero-dependency Node HTTP server on `127.0.0.1:8787`. Does all
  Salesforce Tooling API and Claude calls server-side (no CORS, no extension).
- `chrome-session.js` — reads Chrome's Cookies SQLite DB (via built-in
  `node:sqlite`, on a copy so Chrome can stay open) and decrypts the `sid`
  cookie with the Keychain key (`Chrome Safe Storage`).
- `web/` — the two-pane UI (log list + viewer + Claude panel).

## Troubleshooting

- **"No Salesforce session found in Chrome"** — log into an org in **Google
  Chrome** (the tool reads stable Google Chrome only, not Edge/Brave/Arc/Safari),
  then hit **↻ Refresh**. Visit `http://localhost:<port>/api/diag` (port shown in
  the browser address bar) for non-secret diagnostics (profiles, cookie counts,
  decrypt status).
- **Nothing seems to happen after launch** — the server picks a free port
  automatically; check the log at
  `~/Library/Application Support/Apex Log Analyzer/launch.log`.
- **Analysis says `claude` not found** — install the Claude Code CLI, or set an
  `ANTHROPIC_API_KEY`.

## Privacy — everything is local

There is **no central/shared server**. Each person runs their own copy on their
own Mac; your logs never flow to the author or to any third-party service.

What actually uses the network:

- **Capture, search, view** — the only calls are to **your own Salesforce org's**
  API to *fetch* your logs. Nothing about your logs is sent outward.
- **"Analyze with Claude"** *(only when you click it)* — the selected log's text
  goes to Claude through **your own** `claude` CLI / Anthropic account, exactly
  as if you pasted it into Claude yourself. Nothing is sent automatically.

Your **Salesforce session is never written to disk** — it's read live from
Chrome's cookie store and held only in memory for the running process. The only
file the app writes is `~/.apex-log-analyzer.json` (mode `600`), which holds just
your model choice and an optional Anthropic API key (if you set one instead of
using the `claude` CLI).

The local server accepts requests **only from your own machine**: it binds to
loopback and rejects any request whose `Host`/`Origin` isn't localhost, so a
website you happen to visit can't reach your logs through it.
