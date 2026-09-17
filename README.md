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

> macOS only. Reads Chrome's cookie store locally; nothing is uploaded anywhere.

---

## Run it (no install)

You need **[Node.js 22+](https://nodejs.org)** and **Google Chrome**, with at
least one Salesforce org open in Chrome.

```bash
npx github:YOUR-ORG/apex-log-analyzer
```

That's it — it downloads, starts, and opens `http://localhost:8787` in your
browser. (The tool has no dependencies, so there's nothing to install.)

### Or clone and run

```bash
git clone https://github.com/YOUR-ORG/apex-log-analyzer.git
cd apex-log-analyzer
npm start        # == node server.js
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

## Privacy

Everything runs locally. Your Salesforce session, log bodies, and any API key
never leave your machine except the Salesforce API calls (to your own org) and,
if you analyze a log, the log text sent to Claude via your CLI/API key.
