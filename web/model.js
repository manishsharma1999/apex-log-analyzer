// Structured Apex-log model — the shared "spine" every advanced view is built on.
//
// buildModel(body) walks the raw log ONCE and returns a compact structured model
// (call tree, SOQL/DML inventory with repeat/N+1 grouping, exceptions, governor
// limits with per-namespace attribution, variable assignments, async signals,
// capture-quality flags). Every view (Profile, Flame, Queries, Issues, Vars) and
// the Diagnose / Compare features read this one model instead of re-parsing.
//
// Pure logic, no DOM. Exposed on window.ALA so app.js can consume it.
(function () {
  "use strict";

  // Guardrails so a pathological 20 MB log can never blow up memory or block the
  // tab for long: the parse is a single linear pass and these cap the structures
  // that could otherwise grow without bound.
  const MAX_TREE_NODES = 300000;   // stop growing the call tree past this
  const MAX_VAR_SAMPLES = 20000;   // total VARIABLE_ASSIGNMENT samples kept
  const MAX_VAL_LEN = 600;         // truncate a single variable value
  const MAX_QUERY_LEN = 4000;      // truncate a single SOQL string

  const ENTRY = {
    METHOD_ENTRY: 1, CONSTRUCTOR_ENTRY: 1, SYSTEM_METHOD_ENTRY: 1,
    CODE_UNIT_STARTED: 1, SOQL_EXECUTE_BEGIN: 1, SOSL_EXECUTE_BEGIN: 1,
    DML_BEGIN: 1, CALLOUT_REQUEST: 1, FLOW_START_INTERVIEW_BEGIN: 1,
  };
  const EXIT = {
    METHOD_EXIT: 1, CONSTRUCTOR_EXIT: 1, SYSTEM_METHOD_EXIT: 1,
    CODE_UNIT_FINISHED: 1, SOQL_EXECUTE_END: 1, SOSL_EXECUTE_END: 1,
    DML_END: 1, CALLOUT_RESPONSE: 1, FLOW_START_INTERVIEW_END: 1,
  };

  function nsOf(field0) {
    const m = field0 && field0.match(/\((\d+)\)/);
    return m ? Number(m[1]) : null;
  }

  // A clean, human display name per event type (mirrors the old buildProfile).
  function unitName(ev, parts) {
    const last = (parts[parts.length - 1] || "").trim();
    if (ev === "SOQL_EXECUTE_BEGIN" || ev === "SOSL_EXECUTE_BEGIN") return last;
    if (ev === "DML_BEGIN") return "DML " + parts.slice(3).join(" ").trim();
    if (ev === "CALLOUT_REQUEST") return "Callout " + parts.slice(3).join(" ").trim();
    if (ev === "CODE_UNIT_STARTED") {
      for (let i = parts.length - 1; i >= 2; i--) {
        const f = (parts[i] || "").trim();
        if (f && !/^01p|^__sfdc|^\[|^EXTERNAL$/.test(f)) return f;
      }
      return last;
    }
    return last;
  }

  // Category used by the flame graph colours and the raw-view noise filter.
  function categoryOf(ev) {
    if (!ev) return "other";
    if (/ERROR|EXCEPTION|FATAL|FAIL|ABORT/.test(ev)) return "error";
    if (ev === "USER_DEBUG") return "debug";
    if (/SOQL|SOSL/.test(ev)) return "soql";
    if (/DML/.test(ev)) return "dml";
    if (/CALLOUT/.test(ev)) return "callout";
    if (/FLOW|WF_|WORKFLOW|VALIDATION/.test(ev)) return "flow";
    if (/LIMIT|HEAP|CUMULATIVE|STATISTICS/.test(ev)) return "limit";
    if (/METHOD|CONSTRUCTOR|CODE_UNIT|SYSTEM_METHOD/.test(ev)) return "method";
    return "other";
  }

  // Normalise a SOQL string so runtime-varying bits collapse together — this is
  // what lets us group "the same query ran N times" (N+1 / query-in-loop).
  function normalizeQuery(q) {
    return String(q)
      .replace(/'[^']*'/g, "'?'")             // string literals
      .replace(/:[A-Za-z_][A-Za-z0-9_.]*/g, ":?") // bind variables
      .replace(/\b\d{4,}\b/g, "?")             // long numbers / ids-ish
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 300);
  }

  function truncate(s, n) {
    s = String(s);
    return s.length > n ? s.slice(0, n) + "…" : s;
  }

  function buildModel(body) {
    body = body || "";
    const lines = body.split("\n");

    const roots = [];
    const stack = [];
    const agg = new Map();               // name -> { name, total, self, count }
    let nodeCount = 0, treeCapped = false;

    let firstNs = null, lastNs = null;
    let soqlCount = 0, dmlCount = 0, soslCount = 0, calloutCount = 0, debugCount = 0;

    const soqlMap = new Map();            // normalized -> { sample, norm, count, rows, ns, firstLine, firstLineRef }
    const dmlMap = new Map();             // op:type -> { op, type, count, rows, ns, firstLine }
    const pendingSoql = [];               // stack of open SOQL/SOSL for pairing END
    const pendingDml = [];

    const exceptions = [];                // { line, ns, kind, type, message }
    const vars = new Map();               // varName -> [{ line, ns, lineRef, value }]
    let varSamples = 0, varsCapped = false;

    const limitAgg = new Map();           // label -> { label, used, max }
    const limitByNs = new Map();          // ns -> { label -> {used,max} }
    let curNs = "(default)";

    const codeUnitCounts = new Map();     // for trigger re-entrancy / recursion
    const triggerReentry = new Set();
    const asyncKinds = new Set();
    let truncatedBySF = false;
    let sawMethodTiming = false, sawCumulative = false;

    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      if (!line) continue;

      // Salesforce's own truncation markers — a bad capture wastes the whole
      // investigation, so we surface it prominently.
      if (line.indexOf("MAXIMUM DEBUG LOG SIZE REACHED") >= 0 || line.indexOf("*** Skip") >= 0) {
        truncatedBySF = true;
      }

      // Indented limit lines ("  Number of SOQL queries: 5 out of 100") are not
      // pipe-delimited; handle them before the pipe split.
      const lim = line.match(/(?:Number of|Maximum) ([^:]+):\s*(\d+) out of (\d+)/);
      if (lim) {
        const label = lim[1].trim(), used = +lim[2], max = +lim[3];
        const prev = limitAgg.get(label);
        if (!prev || used > prev.used) limitAgg.set(label, { label, used, max });
        if (!limitByNs.has(curNs)) limitByNs.set(curNs, Object.create(null));
        const b = limitByNs.get(curNs);
        if (!b[label] || used > b[label].used) b[label] = { used, max };
        continue;
      }

      if (line.indexOf("|") < 0) continue;
      const parts = line.split("|");
      const ev = parts[1];
      if (!ev) continue;
      const ns = nsOf(parts[0]);
      if (ns != null) { if (firstNs == null) firstNs = ns; lastNs = ns; }
      const lineRef = (parts[2] && /^\[\d+\]$/.test(parts[2])) ? parts[2] : "";

      if (ev === "CUMULATIVE_LIMIT_USAGE") sawCumulative = true;
      else if (ev === "LIMIT_USAGE_FOR_NS") { curNs = (parts[2] || "(default)").trim() || "(default)"; }

      // --- ENTRY / EXIT: build the call tree + per-name aggregates -----------
      if (ENTRY[ev]) {
        if (ev === "SOQL_EXECUTE_BEGIN") soqlCount++;
        else if (ev === "SOSL_EXECUTE_BEGIN") soslCount++;
        else if (ev === "DML_BEGIN") dmlCount++;
        else if (ev === "CALLOUT_REQUEST") calloutCount++;
        else if (ev === "METHOD_ENTRY") sawMethodTiming = true;

        const name = (unitName(ev, parts) || ev).slice(0, 200);
        const node = { n: name, k: categoryOf(ev), s: ns, e: null, d: 0, self: 0, ln: lineRef, li, c: [] };
        if (nodeCount < MAX_TREE_NODES) {
          if (stack.length) stack[stack.length - 1].node.c.push(node);
          else roots.push(node);
          nodeCount++;
        } else { treeCapped = true; }
        stack.push({ node, child: 0 });

        if (ev === "CODE_UNIT_STARTED") {
          const c = (codeUnitCounts.get(name) || 0) + 1;
          codeUnitCounts.set(name, c);
          // Same trigger already on the stack => genuine re-entrancy/recursion.
          if (/trigger event/i.test(name)) {
            for (let s = 0; s < stack.length - 1; s++) {
              if (stack[s].node.n === name) { triggerReentry.add(name); break; }
            }
          }
          if (/\bfuture\b/i.test(name)) asyncKinds.add("@future");
          if (/queueable/i.test(name)) asyncKinds.add("Queueable");
          if (/batch/i.test(name)) asyncKinds.add("Batchable");
          if (/schedulable|scheduled/i.test(name)) asyncKinds.add("Scheduled");
        }
        if (ev === "SOQL_EXECUTE_BEGIN" || ev === "SOSL_EXECUTE_BEGIN") {
          const q = truncate(parts.slice(4).join("|").trim(), MAX_QUERY_LEN);
          pendingSoql.push({ q, ns, li, lineRef });
        } else if (ev === "DML_BEGIN") {
          // Null-proto so a log field literally named "Op"/"Type"/"Rows" (or
          // "__proto__") can't collide with Object.prototype keys.
          const f = Object.create(null);
          for (let i = 3; i < parts.length; i++) {
            const kv = parts[i].split(":");
            if (kv.length >= 2) f[kv[0].trim()] = kv.slice(1).join(":").trim();
          }
          pendingDml.push({ op: f.Op || "DML", type: f.Type || "", rows: +f.Rows || 0, ns, li });
        }
      } else if (EXIT[ev] && stack.length) {
        const top = stack.pop();
        const nd = top.node;
        nd.e = ns;
        const dur = (ns != null && nd.s != null) ? ns - nd.s : 0;
        nd.d = dur;
        nd.self = dur - top.child;
        if (stack.length) stack[stack.length - 1].child += dur;
        const rec = agg.get(nd.n) || { name: nd.n, total: 0, self: 0, count: 0, cat: nd.k };
        rec.total += dur; rec.self += nd.self; rec.count++;
        agg.set(nd.n, rec);

        if ((ev === "SOQL_EXECUTE_END" || ev === "SOSL_EXECUTE_END") && pendingSoql.length) {
          const b = pendingSoql.pop();
          const rows = (line.match(/Rows:(\d+)/) || [])[1];
          const norm = normalizeQuery(b.q);
          let g = soqlMap.get(norm);
          if (!g) { g = { sample: b.q, norm, count: 0, rows: 0, ns: 0, firstLine: b.li, firstLineRef: b.lineRef }; soqlMap.set(norm, g); }
          g.count++; g.rows += rows ? +rows : 0;
          g.ns += (ns != null && b.ns != null) ? ns - b.ns : 0;
        } else if (ev === "DML_END" && pendingDml.length) {
          const b = pendingDml.pop();
          const key = b.op + ":" + b.type;
          let g = dmlMap.get(key);
          if (!g) { g = { op: b.op, type: b.type, count: 0, rows: 0, ns: 0, firstLine: b.li }; dmlMap.set(key, g); }
          g.count++; g.rows += b.rows;
          g.ns += (ns != null && b.ns != null) ? ns - b.ns : 0;
        }
        continue;
      }

      // --- non-tree events ---------------------------------------------------
      if (ev === "USER_DEBUG") debugCount++;
      else if (ev === "FATAL_ERROR") {
        exceptions.push({ line: li, ns, kind: "fatal", type: "FATAL_ERROR", message: truncate(parts.slice(2).join("|").trim(), 400) });
      } else if (ev === "EXCEPTION_THROWN") {
        const msg = parts.slice(3).join("|").trim() || parts.slice(2).join("|").trim();
        const type = (msg.match(/^([A-Za-z0-9_.]+):/) || [])[1] || "Exception";
        exceptions.push({ line: li, ns, kind: "exception", type, message: truncate(msg, 400) });
      } else if (ev === "VARIABLE_ASSIGNMENT" && varSamples < MAX_VAR_SAMPLES) {
        const name = (parts[3] || "").trim();
        if (name && !/^0x/.test(name)) {
          let val = parts.slice(4).join("|").trim();
          // last field is often a heap ref like 0x3f8b1c2d — drop it for clarity
          val = val.replace(/\|?0x[0-9a-f]+\s*$/i, "").trim();
          let arr = vars.get(name);
          if (!arr) { arr = []; vars.set(name, arr); }
          arr.push({ line: li, ns, lineRef, value: truncate(val, MAX_VAL_LEN) });
          varSamples++;
          if (varSamples >= MAX_VAR_SAMPLES) varsCapped = true;
        }
      }
    }

    // Close any still-open frames (truncated logs) so timings are complete.
    while (stack.length) {
      const top = stack.pop();
      const nd = top.node;
      if (nd.e == null) { nd.e = lastNs; nd.d = (lastNs != null && nd.s != null) ? lastNs - nd.s : 0; nd.self = nd.d - top.child; }
      const rec = agg.get(nd.n) || { name: nd.n, total: 0, self: 0, count: 0, cat: nd.k };
      rec.total += nd.d; rec.self += nd.self; rec.count++;
      agg.set(nd.n, rec);
    }

    const totalNs = (firstNs != null && lastNs != null) ? lastNs - firstNs : 0;
    const slowest = [...agg.values()].sort((a, b) => b.total - a.total);
    const soql = [...soqlMap.values()].sort((a, b) => b.count - a.count || b.ns - a.ns);
    const dml = [...dmlMap.values()].sort((a, b) => b.count - a.count);
    const limits = [...limitAgg.values()];

    // Depth of the deepest frame (for the flame-graph canvas height).
    let maxDepth = 0;
    (function depthOf(nodes, d) {
      if (d > maxDepth) maxDepth = d;
      for (const n of nodes) if (n.c.length) depthOf(n.c, d + 1);
    })(roots, 1);

    return {
      lineCount: lines.length,
      roots, slowest, maxDepth, treeCapped,
      totalNs, firstNs, lastNs,
      soqlCount, dmlCount, soslCount, calloutCount, debugCount,
      soql, dml, exceptions,
      vars, varsCapped,
      limits, limitByNs,
      triggerReentry: [...triggerReentry],
      asyncKinds: [...asyncKinds],
      truncatedBySF, sawMethodTiming, sawCumulative,
    };
  }

  // --- deterministic detectors ---------------------------------------------
  // Reproducible, zero-LLM findings. These are what make investigation fast:
  // the top suspects are on screen before Claude says a word.
  function limitPct(model, labelRe) {
    const l = model.limits.find((x) => labelRe.test(x.label));
    if (!l || !l.max) return null;
    return { label: l.label, used: l.used, max: l.max, pct: Math.round(100 * l.used / l.max) };
  }
  function ms(ns) { return (ns / 1e6).toFixed(1); }

  function detectIssues(model) {
    const out = [];
    const add = (severity, category, title, detail, line) =>
      out.push({ severity, category, title, detail, line: line == null ? null : line });

    if (model.truncatedBySF) {
      add("High", "capture", "Log was truncated by Salesforce",
        "The log hit the debug-log size cap (or has skipped sections), so parts of the transaction are missing. Narrow the debug levels or the time window and re-capture for a complete picture.");
    }

    // SOQL repeated many times => query in a loop / N+1.
    for (const g of model.soql) {
      if (g.count >= 5) {
        add(g.count >= 25 ? "High" : "Medium", "n+1",
          `SOQL runs ${g.count}× (likely a query in a loop / N+1)`,
          `The same query shape executed ${g.count} times${g.rows ? `, returning ${g.rows} rows total` : ""}. Move it outside the loop or bulkify with a map. Query: ${truncate(g.sample, 200)}`,
          g.firstLine);
      }
    }

    // Governor limits near the cap.
    const checks = [
      [/SOQL queries/i, "soql-limit", "SOQL queries"],
      [/DML statements/i, "dml-limit", "DML statements"],
      [/CPU time/i, "cpu", "CPU time"],
      [/heap/i, "heap", "Heap size"],
      [/query rows/i, "rows", "Query rows"],
      [/DML rows/i, "dml-rows", "DML rows"],
      [/callouts/i, "callouts", "Callouts"],
    ];
    for (const [re, cat, label] of checks) {
      const p = limitPct(model, re);
      if (p && p.pct >= 75) {
        add(p.pct >= 90 ? "High" : "Medium", cat,
          `${label} at ${p.pct}% of the governor limit`,
          `${p.used} of ${p.max} used. ${p.pct >= 100 ? "This limit was exceeded." : "Approaching the limit — a slightly larger data volume could break this transaction."}`);
      }
    }

    // Unhandled fatal error.
    for (const ex of model.exceptions) {
      if (ex.kind === "fatal") {
        add("High", "exception", `Fatal error: ${truncate(ex.type === "FATAL_ERROR" ? ex.message.split("\n")[0] : ex.type, 80)}`,
          ex.message, ex.line);
      }
    }
    const thrown = model.exceptions.filter((e) => e.kind === "exception");
    if (thrown.length) {
      const first = thrown[0];
      add("Medium", "exception", `${thrown.length} exception${thrown.length === 1 ? "" : "s"} thrown`,
        `First: ${truncate(first.message, 200)}${thrown.length > 1 ? ` (+${thrown.length - 1} more)` : ""}`, first.line);
    }

    // Trigger re-entrancy / recursion.
    for (const t of model.triggerReentry) {
      add("Medium", "recursion", "Trigger re-entrancy detected",
        `"${truncate(t, 100)}" was entered again while already executing — guard against recursion with a static flag.`);
    }

    // Slowest single operation.
    const slow = model.slowest.find((r) => r.cat === "method" || r.cat === "soql" || r.cat === "dml");
    if (slow && slow.self / 1e6 >= 500) {
      add(slow.self / 1e6 >= 2000 ? "High" : "Medium", "performance",
        `Slow operation: ${truncate(slow.name, 80)} (${ms(slow.self)} ms self)`,
        `Self time ${ms(slow.self)} ms across ${slow.count} call(s). This dominates the transaction — profile it in the Flame view.`);
    }

    // Capture quality: no method timings captured.
    if (!model.sawMethodTiming && model.totalNs === 0) {
      add("Low", "capture", "No method timing captured",
        "The debug level didn't record method entry/exit, so timings and the flame graph are unavailable. Set Apex Code = FINE (or FINEST) and enable Profiling in Setup → Debug Levels.");
    }

    const rank = { High: 0, Medium: 1, Low: 2 };
    out.sort((a, b) => rank[a.severity] - rank[b.severity]);
    return out;
  }

  // --- compact digest for Claude (defeats the 160k raw-text truncation) -----
  // We send extracted facts from the WHOLE log rather than a head+tail slice of
  // raw text, so analysis reasons over full signal at a fraction of the tokens.
  function buildDigest(model, label) {
    const L = [];
    L.push(`# Apex log digest${label ? " — " + label : ""}`);
    if (model.truncatedBySF) L.push(`> NOTE: the raw log was truncated by Salesforce; some events are missing.`);
    L.push("");
    L.push("## Overview");
    L.push(`- Wall time: ${ms(model.totalNs)} ms`);
    L.push(`- SOQL: ${model.soqlCount} · SOSL: ${model.soslCount} · DML: ${model.dmlCount} · Callouts: ${model.calloutCount} · Debug lines: ${model.debugCount}`);
    if (model.asyncKinds.length) L.push(`- Async work: ${model.asyncKinds.join(", ")}`);

    if (model.limits.length) {
      L.push("\n## Governor limits (used / max)");
      for (const l of model.limits) L.push(`- ${l.label}: ${l.used} / ${l.max}`);
    }
    const issues = detectIssues(model);
    if (issues.length) {
      L.push("\n## Deterministic findings (pre-computed, reliable)");
      for (const f of issues) L.push(`- [${f.severity}] ${f.title} — ${truncate(f.detail, 240)}`);
    }
    if (model.exceptions.length) {
      L.push("\n## Exceptions / errors");
      for (const e of model.exceptions.slice(0, 15)) L.push(`- (${e.kind}) ${truncate(e.message, 240)}`);
    }
    if (model.soql.length) {
      L.push("\n## SOQL inventory (count × rows × ms — most-repeated first)");
      for (const g of model.soql.slice(0, 20)) L.push(`- ${g.count}× · ${g.rows} rows · ${ms(g.ns)} ms — ${truncate(g.sample, 200)}`);
    }
    if (model.dml.length) {
      L.push("\n## DML");
      for (const g of model.dml.slice(0, 20)) L.push(`- ${g.count}× ${g.op} ${g.type} · ${g.rows} rows · ${ms(g.ns)} ms`);
    }
    if (model.slowest.length) {
      L.push("\n## Slowest operations (total ms / self ms / calls)");
      for (const r of model.slowest.slice(0, 15)) L.push(`- ${truncate(r.name, 120)}: ${ms(r.total)} / ${ms(r.self)} / ${r.count}`);
    }
    return L.join("\n");
  }

  // --- semantic diff of two models (deterministic; for Compare) -------------
  function diffModels(a, b) {
    const rows = [];
    const num = (label, av, bv, lowerIsBetter) => {
      if (av === 0 && bv === 0) return;
      const delta = bv - av;
      rows.push({ label, a: av, b: bv, delta, worse: lowerIsBetter ? delta > 0 : delta < 0, better: lowerIsBetter ? delta < 0 : delta > 0 });
    };
    num("Wall time (ms)", +ms(a.totalNs), +ms(b.totalNs), true);
    num("SOQL queries", a.soqlCount, b.soqlCount, true);
    num("DML statements", a.dmlCount, b.dmlCount, true);
    num("Callouts", a.calloutCount, b.calloutCount, true);
    num("Exceptions", a.exceptions.length, b.exceptions.length, true);

    // Limits present in either.
    const labels = new Set([...a.limits, ...b.limits].map((l) => l.label));
    const la = new Map(a.limits.map((l) => [l.label, l.used]));
    const lb = new Map(b.limits.map((l) => [l.label, l.used]));
    for (const label of labels) num(label, la.get(label) || 0, lb.get(label) || 0, true);

    // SOQL shapes that appeared / disappeared / changed count.
    const qa = new Map(a.soql.map((g) => [g.norm, g]));
    const qb = new Map(b.soql.map((g) => [g.norm, g]));
    const queryChanges = [];
    for (const [norm, g] of qb) {
      const prev = qa.get(norm);
      if (!prev) queryChanges.push({ kind: "added", count: g.count, sample: g.sample });
      else if (g.count !== prev.count) queryChanges.push({ kind: "changed", from: prev.count, count: g.count, sample: g.sample });
    }
    for (const [norm, g] of qa) if (!qb.has(norm)) queryChanges.push({ kind: "removed", count: g.count, sample: g.sample });

    return { rows, queryChanges };
  }

  window.ALA = { buildModel, detectIssues, buildDigest, diffModels, normalizeQuery, categoryOf, msFromNs: ms };
})();
