#!/usr/bin/env node
/* Data-consistency check for the Frontier Board data blocks in index.html.
   No dependencies. Usage: node scripts/check-data.mjs [path/to/index.html]
   Exits 1 if any error is found; warnings are printed but do not fail. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const file = process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), "..", "index.html");
const html = readFileSync(file, "utf8");
const errors = [], warnings = [];
const err = m => errors.push(m), warn = m => warnings.push(m);

/* ---------- load the data blocks ---------- */
function slice(from, to) {
  const a = html.indexOf(from), b = html.indexOf(to, a);
  if (a < 0 || b < 0) throw new Error(`Could not find ${from} … ${to} in ${file}`);
  return html.slice(a, b);
}
const dataJs = slice("const ASOF", "/* ============================== rendering");
const cavJs = slice("const CAVEATS=", "function renderSources");
const D = vm.runInNewContext(`(function(){${dataJs}\n${cavJs}\nreturn {ASOF,ASOF_NOTE,BENCH,MODELS,EFFORT,PRICES,CHANGELOG,CAVEATS};})()`);
const { ASOF, ASOF_NOTE, BENCH, MODELS, EFFORT, PRICES, CHANGELOG, CAVEATS } = D;
const listConst = name => {
  const m = html.match(new RegExp(`const ${name}=\\[([\\s\\S]*?)\\];`));
  if (!m) throw new Error(`Could not find ${name}`);
  return [...m[1].matchAll(/"([^"]+)"/g)].map(x => x[1]);
};
const BENCH_ORDER = listConst("BENCH_ORDER");
const EFF_ORDER = listConst("EFF_ORDER");

/* ---------- dates ---------- */
const MON = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
// Latest "D Mon [YYYY]" date mentioned in a free-text asof; a missing year borrows the first one given.
function latestDate(text) {
  const ms = [...String(text).matchAll(/\b(\d{1,2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)(?: (\d{4}))?\b/g)];
  if (!ms.length) return null;
  const year = +(ms.find(m => m[3]) || [])[3];
  if (!year) return null;
  return new Date(Math.max(...ms.map(m => Date.UTC(m[3] ? +m[3] : year, MON[m[2]], +m[1]))));
}
const relDate = r => /^\d{4}-\d{2}-\d{2}$/.test(r) ? new Date(r + "T00:00:00Z") : null;

/* ---------- BENCH ---------- */
const GROUPS = ["headline", "speed", "coding", "agentic", "reasoning"];
const FORMATS = ["pct", "usd2", "usd3", "n0", "n1", "ctx", "min"];
const NOT_IN_ORDER = ["price", "costTask", "ttft", "arc2cost", "weirdmlCost"]; // secondary columns, shown via charts and detail panels
for (const [k, B] of Object.entries(BENCH)) {
  for (const f of ["l", "s", "g", "f", "src", "url", "asof", "d"]) if (B[f] == null || B[f] === "") err(`BENCH.${k}: missing ${f}`);
  if (!GROUPS.includes(B.g)) err(`BENCH.${k}: unknown group "${B.g}"`);
  if (!FORMATS.includes(B.f)) err(`BENCH.${k}: unknown format "${B.f}"`);
  if (B.hi !== 0 && B.hi !== 1) err(`BENCH.${k}: hi must be 0 or 1`);
  if (!BENCH_ORDER.includes(k) && !NOT_IN_ORDER.includes(k)) err(`BENCH.${k}: not listed in BENCH_ORDER`);
}
for (const k of BENCH_ORDER) if (!BENCH[k]) err(`BENCH_ORDER: "${k}" has no BENCH entry`);

/* ---------- MODELS ---------- */
const names = new Set();
const byName = {};
for (const m of MODELS) {
  const id = `MODELS["${m.name}"]`;
  if (names.has(m.name)) err(`${id}: duplicate model name`);
  names.add(m.name); byName[m.name] = m;
  if (!m.prov) err(`${id}: missing prov`);
  if (!["frontier", "challenger", "legacy"].includes(m.tier)) err(`${id}: unknown tier "${m.tier}"`);
  if (typeof m.open !== "boolean") err(`${id}: open must be true or false`);
  if (!/^\d{4}(-\d{2}(-\d{2})?)?$/.test(m.rel || "")) err(`${id}: rel "${m.rel}" is not YYYY, YYYY-MM or YYYY-MM-DD`);
  for (const [k, t] of Object.entries(m.s || {})) {
    const at = `${id}.s.${k}`;
    if (!BENCH[k]) { err(`${at}: unknown benchmark id`); continue; }
    if (!Array.isArray(t) || t.length < 2 || t.length > 3) { err(`${at}: must be [value, quality, optional note]`); continue; }
    if (typeof t[0] !== "number" || !Number.isFinite(t[0])) err(`${at}: value is not a finite number`);
    if (!["ind", "ven", "unv"].includes(t[1])) err(`${at}: quality "${t[1]}" is not ind/ven/unv`);
    if (t.length === 3 && typeof t[2] !== "string") err(`${at}: note must be a string`);
    if (k === "ctx" && t[1] !== "ven") err(`${at}: context windows come from provider docs and must be "ven"`);
    if (k === "price" && /computed/i.test(t[2] || "") && t[1] !== "ven") err(`${at}: a price the board computed from list prices must be "ven"`);
    const asof = latestDate(BENCH[k].asof), rel = relDate(m.rel);
    if (asof && rel && rel > asof) err(`${at}: model released ${m.rel} but BENCH.${k}.asof is "${BENCH[k].asof}" — bump asof`);
  }
  // Notes must not quote an Index score the model no longer has.
  const note = m.note || "", aaii = m.s?.aaii?.[0];
  for (const x of note.matchAll(/\b(?:Index(?: score)?(?: of| at)?|(?:scores|measures) it(?: at)?)\s+(\d{1,2})\b(?!\.\d|%)/g)) {
    const n = +x[1];
    if (aaii == null) err(`${id}.note: quotes "${x[0]}" but the model has no aaii score`);
    else if (n !== aaii) err(`${id}.note: quotes "${x[0]}" but aaii is ${aaii}`);
  }
  // Speed claims that differ from the measured speed, unless the measured figure is also quoted.
  const speed = m.s?.speed?.[0];
  for (const x of note.matchAll(/([\d,]+) tokens per second/g)) {
    const n = +x[1].replace(/,/g, "");
    if (speed != null && n !== speed && !note.includes(String(speed))) warn(`${id}.note: says ${x[0]} but speed is ${speed}`);
  }
}

/* ---------- EFFORT & PRICES ---------- */
for (const [n, rows] of Object.entries(EFFORT)) {
  const m = byName[n];
  if (!m) { err(`EFFORT["${n}"]: no model with that name`); continue; }
  rows.forEach((r, i) => {
    if (r.length !== 5) err(`EFFORT["${n}"][${i}]: must be [level, index, cost, tok/s, ttft]`);
    if (rows.length > 1 && !EFF_ORDER.includes(r[0])) err(`EFFORT["${n}"][${i}]: level "${r[0]}" is not in EFF_ORDER`);
  });
  const [, idx, cost, spd] = rows[0];
  if (m.s.aaii && m.s.aaii[0] !== idx) err(`EFFORT["${n}"]: first row index ${idx} ≠ aaii ${m.s.aaii[0]}`);
  if (m.s.costTask && cost != null && m.s.costTask[0] !== cost) err(`EFFORT["${n}"]: first row cost ${cost} ≠ costTask ${m.s.costTask[0]}`);
  if (m.s.speed && spd != null && m.s.speed[0] !== spd) warn(`EFFORT["${n}"]: first row speed ${spd} ≠ speed ${m.s.speed[0]}`);
}
for (const [n, p] of Object.entries(PRICES)) {
  if (!byName[n]) err(`PRICES["${n}"]: no model with that name`);
  for (const f of ["in", "out"]) if (typeof p[f] !== "number") err(`PRICES["${n}"]: ${f} must be a number`);
}

/* ---------- ASOF & CHANGELOG ---------- */
if (!CHANGELOG.length) err("CHANGELOG is empty");
else {
  if (CHANGELOG[0].d !== ASOF) err(`ASOF "${ASOF}" ≠ newest CHANGELOG date "${CHANGELOG[0].d}"`);
  let prev = null;
  CHANGELOG.forEach((e, i) => {
    const d = latestDate(e.d);
    if (!d) err(`CHANGELOG[${i}]: unreadable date "${e.d}"`);
    else if (prev && d > prev) err(`CHANGELOG[${i}] "${e.d}" is newer than the entry above it — keep newest first`);
    if (d) prev = d;
    if (!e.items?.length) err(`CHANGELOG[${i}]: no items`);
    (e.items || []).forEach(([t, x], j) => {
      if (!["add", "data", "rescale", "move", "feature"].includes(t)) err(`CHANGELOG[${i}].items[${j}]: unknown tag "${t}"`);
      if (!x) err(`CHANGELOG[${i}].items[${j}]: empty text`);
    });
  });
}
if (!ASOF_NOTE.includes(ASOF)) warn(`ASOF_NOTE does not mention ASOF "${ASOF}"`);
if (!CAVEATS.every(c => c.length === 2 && c[0] && c[1])) err("CAVEATS: every entry must be [title, text]");

/* ---------- whole-file rules ---------- */
const BANNED = ["llm-stats", "llmstats", "benchlm", "modelcap", "benchgecko", "neosignal", "localaimaster"];
for (const b of BANNED) {
  const i = html.toLowerCase().indexOf(b);
  if (i >= 0) err(`Banned aggregator "${b}" is cited at line ${html.slice(0, i).split("\n").length}`);
}
if (!html.includes("© 2026 millibus. All rights reserved.")) err("Copyright line is missing from the page");

/* ---------- report ---------- */
const nTuples = MODELS.reduce((a, m) => a + Object.keys(m.s || {}).length, 0);
for (const w of warnings) console.log("warn  " + w);
for (const e of errors) console.log("ERROR " + e);
console.log(`${MODELS.length} models · ${Object.keys(BENCH).length} benchmarks · ${nTuples} scores · ASOF ${ASOF} — ${errors.length} error(s), ${warnings.length} warning(s)`);
process.exit(errors.length ? 1 : 0);
