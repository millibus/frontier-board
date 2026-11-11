#!/usr/bin/env node
/* Headless-Chromium smoke test for index.html: serves the repo over local HTTP,
   clicks every tab, and fails on page errors, an empty board, or a header that
   doesn't match the data.  Uses an existing playwright / playwright-core install
   (local or global); nothing is added to the site.
   Usage: node scripts/smoke.mjs   (CHROMIUM_PATH overrides the browser binary) */
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, extname, normalize } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

function loadPlaywright() {
  const roots = [root];
  try { roots.push(execSync("npm root -g", { encoding: "utf8" }).trim()); } catch {}
  for (const r of roots) for (const pkg of ["playwright-core", "playwright"]) {
    try { return require(require.resolve(pkg, { paths: [r] })); } catch {}
  }
  console.error("playwright-core or playwright is not installed (locally or globally).");
  process.exit(2);
}
const { chromium } = loadPlaywright();

const html = readFileSync(join(root, "index.html"), "utf8");
const ASOF = html.match(/const ASOF = "([^"]+)"/)[1];
const nModels = (html.slice(html.indexOf("const MODELS"), html.indexOf("const EFFORT")).match(/\{name:"/g) || []).length;

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent(req.url.split("?")[0])).replace(/^(\.\.[/\\])+/, "");
  const file = join(root, path.endsWith("/") ? path + "index.html" : path);
  if (!file.startsWith(root) || !existsSync(file)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": TYPES[extname(file)] || "application/octet-stream" });
  res.end(readFileSync(file));
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/`;

const exe = process.env.CHROMIUM_PATH || (existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
const problems = [];
try {
  const page = await browser.newPage();
  // Google Fonts may be blocked in sandboxes, and the browser asks for a favicon the site has never had; neither is a page bug.
  // Match on the failing request's URL, so any other failed request (same-origin or not) is still reported.
  const ignorable = u => /^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(u) || /\/favicon\.ico(\?|$)/.test(u);
  page.on("pageerror", e => problems.push(`pageerror: ${e.message}`));
  page.on("console", m => { const u = m.location()?.url || ""; if (m.type() === "error" && !ignorable(u)) problems.push(`console: ${m.text()}${u ? ` (${u})` : ""}`); });
  await page.goto(url, { waitUntil: "load" });

  const rows = await page.locator("#board tbody tr[data-m]").count();
  if (!rows) problems.push("Board table has no rows");
  const asof = await page.textContent("#asof"), nm = await page.textContent("#nmodels");
  if (asof !== ASOF) problems.push(`header ASOF "${asof}" ≠ "${ASOF}"`);
  if (+nm !== nModels) problems.push(`header model count ${nm} ≠ ${nModels}`);
  if (!(await page.locator("footer.foot").count())) problems.push("footer is missing");

  await page.locator("#board tbody tr[data-m]").first().click();
  if (!(await page.locator("#board .detbox").count())) problems.push("clicking a row did not open its detail panel");

  for (const t of ["quad", "bench", "src", "board"]) {
    await page.click(`.tab[data-p="${t}"]`);
    const on = await page.locator(`#p-${t}.on`).count();
    if (!on) problems.push(`tab ${t} did not open`);
  }
  if (!(await page.locator("#c-index svg").count())) problems.push("Charts tab rendered no Intelligence Index chart");
  if (!(await page.locator("#benchhost .card").count())) problems.push("Benchmarks tab rendered no cards");
  if (!(await page.locator("#caveats .srccard").count())) problems.push("Sources tab rendered no caveats");

  for (const theme of ["dark", "light"]) await page.click(`.themesw button[data-t="${theme}"]`);
  /* ===== comparison controls + shareable URL: begin =====
     Sets a non-default comparison on the Charts tab, copies the URL into a fresh page and checks that the tab,
     the chart section in view, the picks and every control state come back; then checks reset, search keys,
     tolerance of unknown URL values, and the phone sheet. */
  {
    const fresh = async (u, viewport = { width: 1440, height: 900 }) => {
      const p = await browser.newPage({ viewport });
      p.on("pageerror", e => problems.push(`comparison pageerror: ${e.message}`));
      await p.goto(u, { waitUntil: "load" });
      await p.evaluate(() => document.fonts.ready.then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))));
      return p;
    };
    // everything a copied link has to bring back, read from the DOM and the state object
    const snap = p => p.evaluate(() => {
      const bars = document.querySelector(".top").offsetHeight + document.querySelector(".rail").offsetHeight;
      const cards = [...document.querySelectorAll("#p-quad .card[id^='ch-']")].filter(c => c.getClientRects().length);
      const under = cards.filter(c => c.getBoundingClientRect().top <= bars + 16).pop();
      const pressed = s => [...document.querySelectorAll(s)].map(b => `${b.dataset.k || b.dataset.scale || b.dataset.cmp}=${b.getAttribute("aria-pressed")}`).join(" ");
      return { tab: document.querySelector('.tab[aria-selected="true"]').dataset.p, panel: document.querySelector(".panel.on").id,
        section: under ? under.id : cards.length ? cards[0].id : null, named: state.sec,
        picks: [...state.effSel].join("|"), chips: [...document.querySelectorAll("#effpicked .pchip")].map(b => b.dataset.m).join("|"),
        hide: [...state.cmp.hideEff].sort().join(","), linear: state.cmp.linear, pareto: state.cmp.pareto, labels: state.cmp.labels,
        effort: pressed("#cmpeff .chip"), scale: pressed(".seg [data-scale]"), toggles: pressed('#cmp [data-cmp="pareto"], #cmp [data-cmp="labels"]'),
        count: document.querySelector("#effnote").textContent.split(" ")[0], search: location.search };
    });
    const same = (what, a, b, keys) => { for (const k of keys) if (a[k] !== b[k]) problems.push(`${what}: ${k} "${b[k]}" ≠ "${a[k]}"`); };

    const a = await fresh(url);
    await a.click('.tab[data-p="quad"]');
    const def = await snap(a);
    if (def.search !== "?tab=charts") problems.push(`default Charts URL should be ?tab=charts, got "${def.search}"`);
    if (def.linear || def.pareto || !def.labels || def.hide) problems.push("comparison defaults are not log scale, no Pareto line, labels on, no level hidden");

    // a non-default comparison: drop a pick, add one by an upper-case search, bulk-add a group, hide a level, linear, Pareto, labels off
    await a.locator("#effpicked .pchip").first().click();
    const extra = await a.evaluate(() => effCands().find(m => !state.effSel.has(m.name)).name);
    await a.fill("#effq", extra.toUpperCase());
    await a.press("#effq", "Enter");
    const before = (await snap(a)).picks.split("|");
    await a.click('#cmpgroups [data-g="open"]');
    const afterBulk = (await snap(a)).picks.split("|");
    if (!before.every(n => afterBulk.includes(n)) || afterBulk.length <= before.length) problems.push("bulk-adding a group cleared or failed to extend the existing picks");
    if (!afterBulk.includes(extra)) problems.push(`case-insensitive search did not add ${extra}`);
    const level = await a.locator("#cmpeff .chip").first().getAttribute("data-e");
    await a.click(`#cmpeff .chip[data-e="${level}"]`);
    if (await a.getAttribute(`#cmpeff .chip[data-e="${level}"]`, "aria-pressed") !== "false") problems.push("an excluded effort chip is not aria-pressed=false");
    if (await a.locator(`#cmpeff .chip[data-e="${level}"]`).isDisabled()) problems.push("an excluded effort chip reads as unavailable (disabled)");
    await a.click('.seg [data-scale="linear"]');
    await a.click('[data-cmp="pareto"]');
    await a.click('[data-cmp="labels"]');

    // a chart section that is not the first; then a control that changes the page height must not rename it
    await a.click('#jump a[href="#ch-efflat"]');
    await a.evaluate(() => effChange([...state.effSel].slice(0, -1)));
    const A = await snap(a);
    for (const part of ["tab=charts", "chart=efflat", "models=", `hide=${level}`, "scale=linear", "pareto=1", "labels=0"])
      if (!A.search.includes(part)) problems.push(`URL "${A.search}" is missing ${part}`);
    if (A.section !== "ch-efflat") problems.push(`after the jump link the section in view is ${A.section}, not ch-efflat`);

    // round trip into a fresh page, twice, to catch a restore that depends on timing
    const KEYS = ["tab", "panel", "section", "named", "picks", "chips", "hide", "linear", "pareto", "labels", "effort", "scale", "toggles", "count", "search"];
    for (const n of [1, 2]) {
      const b = await fresh(url + A.search);
      await b.waitForTimeout(250);
      same(`URL round trip ${n}`, A, await snap(b), KEYS);
      if (n === 2) {
        // reset: comparison back to defaults, search cleared, theme and Board filters untouched
        await b.click('.themesw button[data-t="dark"]');
        const tiers = await b.evaluate(() => [...state.tiers].join(","));
        await b.fill("#effq", "zz");
        await b.click(".cmpreset");
        const R = await snap(b);
        same("reset comparison", def, R, ["tab", "picks", "chips", "hide", "linear", "pareto", "labels", "scale", "toggles", "count"]);
        if (R.effort.includes("=false")) problems.push("reset left an effort level excluded");
        if (/models=|hide=|scale=|pareto=|labels=/.test(R.search)) problems.push(`reset left comparison state in the URL: "${R.search}"`);
        if (await b.inputValue("#effq")) problems.push("reset did not clear the model search");
        if (await b.evaluate(() => document.documentElement.getAttribute("data-theme")) !== "dark") problems.push("reset changed the theme");
        if (await b.evaluate(() => [...state.tiers].join(",")) !== tiers) problems.push("reset changed the Board filters");
        // "/" focuses the model search from outside a text field; Escape clears and closes it
        await b.evaluate(() => document.activeElement.blur());
        await b.keyboard.press("/");
        if (await b.evaluate(() => document.activeElement.id) !== "effq") problems.push('pressing "/" did not focus the model search');
        await b.keyboard.type("OPEN");
        if (!(await b.locator("#efflist button").count())) problems.push("searching by provider in upper case matched nothing");
        await b.keyboard.press("Escape");
        if (await b.inputValue("#effq") || !(await b.evaluate(() => document.querySelector("#efflist").hidden))) problems.push("Escape did not clear and close the model search");
      }
      await b.close();
    }

    // unknown ids and values are ignored, and an old-style #ch-… link still lands on its chart
    const known = A.picks.split("|")[0];
    const slugOf = await a.evaluate(n => slug(n), known);
    const c = await fresh(`${url}?tab=nowhere&chart=nope&models=not-a-model,${slugOf}&hide=bogus,${level}&scale=cubic&pareto=maybe&labels=perhaps#ch-efflat`);
    const C = await snap(c);
    if (C.tab !== "quad" || C.section !== "ch-efflat") problems.push(`#ch-efflat link opened ${C.tab} / ${C.section}`);
    if (C.picks !== known || C.hide !== level || C.linear || C.pareto || !C.labels) problems.push(`unknown URL values were not ignored: ${JSON.stringify(C)}`);
    await c.close();
    await a.close();

    // phone: the controls live in a full-screen sheet behind a "Models N" button
    const m = await fresh(url + "?tab=charts&chart=effcost", { width: 390, height: 844 });
    if (await m.locator("#cmp").isVisible()) problems.push("phone: comparison controls are inline instead of in the sheet");
    const n0 = await m.textContent("#ch-effcost .cmpopen .cmpn");
    await m.click("#ch-effcost .cmpopen");
    const sheet = await m.evaluate(() => { const s = document.querySelector("#cmp"), r = s.getBoundingClientRect(), h = document.querySelector(".cmphead");
      return { dialog: s.getAttribute("role"), full: r.width >= innerWidth - 1 && r.height >= innerHeight - 1, expanded: document.querySelector(".cmpopen").getAttribute("aria-expanded"),
        head: getComputedStyle(h).position, reset: !!h.querySelector('[data-cmp="reset"]'), count: h.querySelector(".cmpn").textContent,
        row: Math.min(...[...document.querySelectorAll("#efflist button")].slice(0, 5).map(b => b.getBoundingClientRect().height)) }; });
    if (sheet.dialog !== "dialog" || !sheet.full || sheet.expanded !== "true") problems.push(`phone: sheet did not open full-screen: ${JSON.stringify(sheet)}`);
    if (sheet.head !== "sticky" || !sheet.reset || sheet.count !== n0) problems.push(`phone: sheet header lacks sticky count/reset: ${JSON.stringify(sheet)}`);
    if (!(sheet.row >= 44)) problems.push(`phone: sheet rows are ${sheet.row}px tall, under 44`);
    await m.locator("#efflist button[aria-pressed='false']").first().click();
    await m.click("#cmpdone");
    const M = await snap(m);
    if (await m.locator("#cmp").isVisible()) problems.push("phone: Done did not close the sheet");
    if (+M.count !== +n0 + 1 || await m.textContent("#ch-effcost .cmpopen .cmpn") !== String(+n0 + 1)) problems.push("phone: the Models count did not follow a pick made in the sheet");
    if (M.named !== "effcost" || M.section !== "ch-effcost") problems.push(`phone: after the sheet the section is ${M.named} / ${M.section}, not effcost`);
    await m.close();
  }
  /* ===== comparison controls + shareable URL: end ===== */

  console.log(`${rows} board rows · ${nm} models · ASOF ${asof}`);
} finally {
  await browser.close();
  server.close();
}
for (const p of problems) console.log("FAIL  " + p);
console.log(problems.length ? `${problems.length} problem(s)` : "smoke test passed");
process.exit(problems.length ? 1 : 0);
