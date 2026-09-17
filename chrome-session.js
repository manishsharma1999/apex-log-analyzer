// Reads the Salesforce session directly from Chrome's own cookie store on macOS
// — no extension, no CLI login. Chrome encrypts cookie values with an
// AES-128-CBC key stored in the login Keychain ("Chrome Safe Storage"); we read
// that key, decrypt the `sid` cookie for *.my.salesforce.com, and use it as the
// API bearer token.
//
// The first time a non-Chrome process reads that Keychain item, macOS shows a
// one-time "Allow" prompt — click "Always Allow". Chrome may stay open (we work
// on a copy of the DB).

const { execFileSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const CHROME_DIR = path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome");

let cachedKey = null;
function getAesKey() {
  if (cachedKey) return cachedKey;
  // Raw safe-storage password from the login keychain.
  const pw = execFileSync("security", [
    "find-generic-password", "-w", "-s", "Chrome Safe Storage", "-a", "Chrome",
  ]).toString().trim();
  // Chrome (macOS): PBKDF2-HMAC-SHA1, salt "saltysalt", 1003 iters, 16-byte key.
  cachedKey = crypto.pbkdf2Sync(pw, "saltysalt", 1003, 16, "sha1");
  return cachedKey;
}

function looksPrintable(s) {
  return /^[\x09\x0a\x0d\x20-\x7e]*$/.test(s);
}

function decryptCookie(encrypted, key) {
  if (!encrypted || encrypted.length === 0) return "";
  // node:sqlite returns BLOBs as Uint8Array; coerce to Buffer for .toString(enc)
  // and crypto APIs.
  if (!Buffer.isBuffer(encrypted)) encrypted = Buffer.from(encrypted);
  const version = encrypted.slice(0, 3).toString("latin1");
  if (version !== "v10" && version !== "v11") {
    return encrypted.toString("utf8"); // stored in the clear (rare)
  }
  const iv = Buffer.alloc(16, 0x20); // 16 spaces
  const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
  decipher.setAutoPadding(false);
  let out = Buffer.concat([decipher.update(encrypted.slice(3)), decipher.final()]);
  // strip PKCS7 padding
  const pad = out[out.length - 1];
  if (pad > 0 && pad <= 16) out = out.subarray(0, out.length - pad);

  // Newer Chrome prepends a 32-byte SHA-256(domain) to the plaintext. A
  // Salesforce sid is printable and contains '!', so choose the valid form.
  const direct = out.toString("utf8");
  if (direct.includes("!") && looksPrintable(direct)) return direct;
  const stripped = out.subarray(32).toString("utf8");
  if (stripped.includes("!")) return stripped;
  return direct;
}

function profileDirs() {
  let names;
  try {
    names = fs.readdirSync(CHROME_DIR);
  } catch {
    return [];
  }
  return names
    .filter((n) => n === "Default" || /^Profile \d+$/.test(n))
    .map((n) => path.join(CHROME_DIR, n))
    .filter((d) => fs.existsSync(path.join(d, "Cookies")));
}

function readSidCookies(profileDir) {
  const src = path.join(profileDir, "Cookies");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ala-cookies-"));
  const tmp = path.join(tmpDir, "Cookies");
  // Copy DB (+ WAL/SHM) so we can read even while Chrome holds a lock. We open
  // the *copy* read-write (not readOnly): Chrome runs the DB in WAL mode and
  // recent cookies live in the -wal file; SQLite can only merge that WAL if it
  // can write to the (copied) database, so a readOnly open would miss them.
  fs.copyFileSync(src, tmp);
  for (const ext of ["-wal", "-shm"]) {
    if (fs.existsSync(src + ext)) fs.copyFileSync(src + ext, tmp + ext);
  }
  const rows = [];
  try {
    const db = new DatabaseSync(tmp);
    const stmt = db.prepare(
      "SELECT host_key, encrypted_value FROM cookies WHERE name = 'sid' AND host_key LIKE '%salesforce%'"
    );
    for (const r of stmt.all()) rows.push(r);
    db.close();
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  return rows;
}

function hostToApiHost(hostKey) {
  const h = hostKey.replace(/^\./, "").toLowerCase();
  if (h.endsWith(".my.salesforce.com")) return h;
  // Enhanced-domain Setup host (e.g. foo.my.salesforce-setup.com) -> API host.
  if (h.endsWith(".my.salesforce-setup.com")) return h.replace(/\.my\.salesforce-setup\.com$/, ".my.salesforce.com");
  // Legacy instance hosts (naNN.salesforce.com) — skip auth/login/test hosts.
  if (h.endsWith(".salesforce.com") && !/^(login|test|www)\./.test(h)) return h;
  return null;
}

/** Returns [{ apiHost, sessionId, profile, label }] for every logged-in org. */
function detectOrgSessions() {
  const key = getAesKey();
  const byHost = new Map();
  for (const dir of profileDirs()) {
    const profile = path.basename(dir);
    let cookies;
    try {
      cookies = readSidCookies(dir);
    } catch {
      continue;
    }
    for (const c of cookies) {
      const apiHost = hostToApiHost(c.host_key);
      if (!apiHost) continue;
      const value = decryptCookie(c.encrypted_value, key);
      if (!value || !value.includes("!")) continue; // invalid / not a real sid
      const direct = c.host_key.replace(/^\./, "").toLowerCase().endsWith(".my.salesforce.com");
      const existing = byHost.get(apiHost);
      // Prefer a cookie from the true my.salesforce.com host over a setup-domain one.
      if (!existing || (direct && !existing.direct)) {
        byHost.set(apiHost, {
          apiHost,
          sessionId: value,
          profile,
          direct,
          label: apiHost.replace(/\.my\.salesforce\.com$/, "").replace(/\.salesforce\.com$/, ""),
        });
      }
    }
  }
  return [...byHost.values()];
}

/** Non-secret diagnostics to figure out why detection may find nothing. */
function diagnose() {
  const out = { chromeDir: CHROME_DIR, keyOk: false, keyError: null, profiles: [] };
  try {
    getAesKey();
    out.keyOk = true;
  } catch (e) {
    out.keyError = e.message;
  }
  const key = out.keyOk ? cachedKey : null;
  for (const dir of profileDirs()) {
    const p = { profile: path.basename(dir), sidCookieCount: 0, hosts: [], apiHosts: [], versions: {}, decryptOk: 0, error: null };
    try {
      const cookies = readSidCookies(dir);
      p.sidCookieCount = cookies.length;
      for (const c of cookies) {
        if (!p.hosts.includes(c.host_key)) p.hosts.push(c.host_key);
        const api = hostToApiHost(c.host_key);
        if (api && !p.apiHosts.includes(api)) p.apiHosts.push(api);
        const buf = Buffer.from(c.encrypted_value || []);
        const ver = buf.length >= 3 ? buf.slice(0, 3).toString("latin1") : "(short)";
        p.versions[ver] = (p.versions[ver] || 0) + 1;
        if (key) {
          try {
            const v = decryptCookie(c.encrypted_value, key);
            if (v && v.includes("!")) p.decryptOk++;
          } catch { /* count stays */ }
        }
      }
    } catch (e) {
      p.error = e.message;
    }
    out.profiles.push(p);
  }
  return out;
}

module.exports = { detectOrgSessions, decryptCookie, diagnose };
