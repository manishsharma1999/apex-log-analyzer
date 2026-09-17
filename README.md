# ⚡ Apex Log Analyzer

Capture, search, and **Claude-analyze** Salesforce Apex debug logs from a local
web app — with **zero manual setup**. It reads your Salesforce session straight
from Chrome (whatever org you're logged into just shows up), auto-enables debug
logging, and streams new logs as they happen.

- **No browser extension** (works even on MDM-managed Chrome).
- **No `sf` CLI login, no session pasting** — the session comes from Chrome.
- **No Anthropic API key** — analysis uses your local Claude Code CLI by default.
- Multiple logged-in orgs → pick one from a dropdown.
- Search **inside all captured log bodies**, plus per-log find.

> macOS only. Everything runs on your own machine — see **Privacy** below.

---

## Run it — nothing to install

1. Have **Google Chrome** open and logged into a Salesforce org.
2. Double-click **`Apex Log Analyzer.command`**.

That's it. The first run quietly sets up a private Node runtime inside the app
folder (one-time, ~30 MB) if your Mac doesn't already have a recent Node, then
opens `http://localhost:8787` in your browser. No Node install, no `npm install`
(the tool has zero dependencies), no configuration.

> **Gatekeeper note:** if macOS says the file "can't be opened because it is
> from an unidentified developer," **right-click it → Open → Open** once. After
> that, double-click works normally.

### For developers

If you already have **Node 24 (or 22.13+)**:

```bash
npm start          # == node server.js
# or, straight from the repo, no clone:
npx github:YOUR-ORG/apex-log-analyzer
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

Prefer the Anthropic API? Open **⚙ Settings** and paste an `ANTHROPIC_API_KEY`
(or set it as an environment variable). Keys are stored only in
`~/.apex-log-analyzer.json` on your machine (mode `600`).

---

## How it works

- `server.js` — zero-dependency Node HTTP server on `127.0.0.1:8787`. Does all
  Salesforce Tooling API and Claude calls server-side (no CORS, no extension).
- `chrome-session.js` — reads Chrome's Cookies SQLite DB (via built-in
  `node:sqlite`, on a copy so Chrome can stay open) and decrypts the `sid`
  cookie with the Keychain key (`Chrome Safe Storage`).
- `web/` — the two-pane UI (log list + viewer + Claude panel).

## Troubleshooting

- **"No Salesforce session found in Chrome"** — log into an org in Chrome, then
  hit **↻ Refresh**. Visit `http://localhost:8787/api/diag` for non-secret
  diagnostics (profiles, cookie counts, decrypt status).
- **Port 8787 busy** — the server automatically tries 8788, 8789, … Watch the
  terminal for the actual URL.
- **Analysis says `claude` not found** — install the Claude Code CLI, or add an
  API key in Settings.

## Privacy — everything is local

There is **no central/shared server**. Each person runs their own copy on their
own Mac; your logs never flow to the author or to any third-party service.

What actually uses the network:

- **Capture, search, view** — the only calls are to **your own Salesforce org's**
  API to *fetch* your logs. Nothing about your logs is sent outward.
- **"Analyze with Claude"** *(only when you click it)* — the selected log's text
  goes to Claude through **your own** `claude` CLI / Anthropic account, exactly
  as if you pasted it into Claude yourself. Nothing is sent automatically.

Your Salesforce session and any saved API key stay in
`~/.apex-log-analyzer.json` (mode `600`) on your machine.
