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

  /* ---------- effort-line charts: drawing, point details, hit testing (begin) ---------- */
  {
    const bad = m => problems.push("effort lines: " + m);
    const C = "#c-effcost", vp = page.viewportSize();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.click('.tab[data-p="quad"]');
    await page.waitForTimeout(300); // the debounced resize re-render
    await page.evaluate(() => { window.__cmp = state.cmp; state.cmp = { linear: false, pareto: false, labels: true, hideEff: new Set() }; effChange(effPreset("default")); });
    const toChart = () => page.evaluate(c => scrollBy(0, document.querySelector(c).getBoundingClientRect().top - 230), C);
    const at = async (i, f = null) => page.evaluate(([c, i, f]) => { // client position of point i, or part of the way towards point f[0]
      const ch = effUI.charts[c], b = ch.svg.getBoundingClientRect(), k = b.width / ch.g.W, p = ch.P[i], q = f ? ch.P[f[0]] : p, t = f ? f[1] : 0;
      return [b.left + (p.px + (q.px - p.px) * t) * k, b.top + (p.py + (q.py - p.py) * t) * k]; }, [C, i, f]);
    const card = page.locator(`${C} .effcard`), away = () => page.mouse.move(5, 5);
    const ui = () => page.evaluate(c => ({ hov: effUI.hov && effUI.hov.host === c ? effUI.hov.i : -1, pin: effUI.pin, latch: effUI.latch,
      hl: document.querySelector(c + " .effsvg").classList.contains("hl"), on: [...document.querySelectorAll(c + " .effg.on")].map(g => g.dataset.m) }), C);
    await toChart();
    // a point with no neighbour inside its hit area, and what its card should say
    const iso = await page.evaluate(c => { const P = effUI.charts[c].P, p = P.find(p => P.every(q => q === p || Math.hypot(q.px - p.px, q.py - p.py) > 30)), r = p.r;
      return { i: p.i, name: p.m.name, level: EFF_NAME[r.e], dd: [String(r.aaii), r.cost != null ? money(r.cost) : "—", r.speed != null ? r.speed + " tok/s" : "—", r.ttft != null ? r.ttft + " s" : "—"], url: BENCH.aaii.url, n: P.length }; }, C);
    const href0 = page.url();

    // hover shows a card, crosshairs and the emphasis; nothing is pinned yet
    await page.mouse.move(...await at(iso.i));
    if (!(await card.isVisible())) bad("hovering a point shows no card");
    const hoverText = await card.innerText();
    if (!hoverText.includes(iso.name) || hoverText.includes("Pinned")) bad(`hover card text is wrong: ${JSON.stringify(hoverText)}`);
    if (await card.getByRole("button", { name: "Close details" }).count()) bad("hover card offers a close button before it is pinned");
    if ((await page.locator(`${C} .effcross line`).count()) !== 2) bad("hover does not draw two crosshair lines");
    if ((await page.locator(`${C} .effxv text`).count()) !== 2) bad("hover does not print the values at the axes");
    if ((await page.locator(`${C} .effpt.act`).count()) !== 1) bad("hover does not enlarge exactly one point");
    let u = await ui();
    if (!u.hl || u.on.join() !== iso.name) bad("hover does not dim the other series");
    await away();
    if (await card.isVisible()) bad("an unpinned card stays after the pointer leaves");

    // click pins: the fields, the source link, survival, and both ways of closing
    await page.mouse.click(...await at(iso.i));
    await away();
    if (!(await card.isVisible())) bad("a pinned card does not survive the pointer leaving");
    const head = await card.locator(".effcs").innerText();
    if (!head.includes(iso.level) || !head.includes("Pinned")) bad(`pinned card heading is wrong: ${JSON.stringify(head)}`);
    if ((await card.locator("b").innerText()).trim() !== iso.name) bad("pinned card names the wrong model");
    const dt = await card.locator("dt").allInnerTexts(), dd = await card.locator("dd").allInnerTexts();
    if (dt.join("|") !== "Index score|Cost per index task|Output speed|Time to first answer token") bad(`card fields are ${dt.join("|")}`);
    if (dd.join("|") !== iso.dd.join("|")) bad(`card values ${dd.join("|")} ≠ ${iso.dd.join("|")}`);
    if ((await card.locator("a").getAttribute("href")) !== iso.url) bad("card source link is not BENCH.aaii.url");
    if (page.url() !== href0) bad("pinning changed the URL");
    if ((await page.locator(`${C} .effhit[aria-pressed="true"]`).count()) !== 1) bad("the pinned point is not marked pressed");
    await card.getByRole("button", { name: "Close details" }).click();
    if (await card.isVisible()) bad("the close button does not close the card");
    await page.mouse.click(...await at(iso.i)); await away();
    await page.keyboard.press("Escape");
    if (await card.isVisible()) bad("Escape does not close the card");

    // keyboard: points are focusable and named, Enter pins, Space releases
    const hit = page.locator(`${C} .effhit`).nth(iso.i);
    if (!(await hit.getAttribute("aria-label") || "").startsWith(iso.name + ", ")) bad("a point's accessible name does not start with its model");
    await hit.focus(); await page.keyboard.press("Enter");
    if (!(await ui()).pin || !(await card.isVisible())) bad("Enter on a focused point does not pin it");
    await page.keyboard.press(" ");
    if ((await ui()).pin) bad("Space on the pinned point does not release it");
    await page.evaluate(() => document.activeElement.blur());

    // a re-render drops a card whose model is no longer drawn
    await page.mouse.click(...await at(iso.i)); await away();
    await page.evaluate(n => effChange([...state.effSel].filter(x => x !== n)), iso.name);
    if ((await ui()).pin || await card.isVisible()) bad("a card outlives its model being removed");
    await page.evaluate(() => effChange(effPreset("default")));

    // a label click latches the highlight, hover-out of a picker chip keeps it, a second click releases it
    await toChart();
    const lab = page.locator(`${C} .efflab`).first(), labName = await lab.getAttribute("data-m");
    await lab.click(); await away();
    u = await ui();
    if (!u.hl || u.on.join() !== labName || (await lab.getAttribute("aria-pressed")) !== "true") bad("a label click does not latch its series");
    if (await card.isVisible()) bad("a label shows a card");
    await page.evaluate(n => { effHover([...state.effSel].find(x => x !== n)); effHover(null); }, labName);
    u = await ui();
    if (!u.hl || u.on.join() !== labName) bad("the latched highlight is lost when a picker chip is hovered and left");
    await lab.click(); await away();
    u = await ui();
    if (u.hl || u.latch || (await lab.getAttribute("aria-pressed")) !== "false") bad("a second label click does not release the latch");

    // comparison settings: linear axis, frontier, labels off, one effort level hidden
    const title = () => page.locator(`${C} .axtitle`).first().textContent();
    if (!/log scale$/.test(await title())) bad("the default axis title does not say log scale");
    if (await page.locator(`${C} .efffront`).count()) bad("a frontier is drawn while Pareto is off");
    const lvl = await page.evaluate(c => { const P = effUI.charts[c].P, e = P.find(p => p.r.e !== "one").r.e; state.cmp = { linear: true, pareto: true, labels: false, hideEff: new Set([e]) };
      renderEffLines(); return { e, n: P.filter(p => p.r.e === e).length }; }, C);
    if (!/linear scale$/.test(await title())) bad("the axis title does not say linear scale");
    if ((await page.locator(`${C} .axlab`).first().textContent()) !== "$0") bad("the linear axis does not start at $0");
    if ((await page.locator(`${C} .efffront`).count()) !== 1 || !(await page.locator(`${C} .effring`).count())) bad("Pareto draws no frontier");
    if (!(await page.locator(`${C} .effpt.dom`).count())) bad("Pareto dims no dominated point");
    const ringed = await page.evaluate(c => { const P = effUI.charts[c].P, f = P.filter(p => !P.some(q => q !== p && q.r.cost <= p.r.cost && q.r.aaii >= p.r.aaii && (q.r.cost < p.r.cost || q.r.aaii > p.r.aaii)));
      return [new Set(f.map(p => p.px.toFixed(1) + "," + p.py.toFixed(1))).size, document.querySelectorAll(c + " .effring").length]; }, C);
    if (ringed[0] !== ringed[1]) bad(`${ringed[1]} frontier points ringed, ${ringed[0]} are non-dominated`);
    if (await page.locator(`${C} .efflab, ${C} .effleader`).count()) bad("labels off still draws labels or leader lines");
    if (!(await page.locator(`${C} .effline`).count())) bad("labels off removed the lines");
    const n1 = await page.locator(`${C} .effhit`).count();
    if (n1 !== iso.n - lvl.n) bad(`hiding ${lvl.e} left ${n1} points, expected ${iso.n - lvl.n}`);
    await page.evaluate(() => { state.cmp = { linear: false, pareto: false, labels: true, hideEff: new Set() }; renderEffLines(); });

    // many models: the count of unlabelled lines is stated and each one is listed
    await page.evaluate(() => effChange(effCands().map(m => m.name)));
    const many = await page.evaluate(c => ({ lines: document.querySelectorAll(c + " .effg").length, labs: document.querySelectorAll(c + " .efflab").length,
      note: (document.querySelector(c + " .effmoren") || {}).textContent || "", listed: document.querySelectorAll(c + " .effmore button").length,
      gap: Math.min(...[...document.querySelectorAll(c + " .efflab rect")].map(r => +r.getAttribute("y")).sort((a, b) => a - b).map((y, i, a) => i ? y - a[i - 1] : 99)) }), C);
    const miss = many.lines - many.labs;
    if (miss <= 0) bad("picking every model still labels every line, so the not-labelled count is untested");
    else if (+(many.note.match(/^\+(\d+) /) || [])[1] !== miss || many.listed !== miss) bad(`${miss} lines have no label but the chart says "${many.note}" and lists ${many.listed}`);
    if (many.gap < 17.9) bad(`labels are ${many.gap.toFixed(1)} apart, closer than the minimum spacing`);

    // crowded points: the pointer gets the nearer of two points whose hit areas overlap, whichever was drawn last
    await toChart();
    const pair = await page.evaluate(c => { const P = effUI.charts[c].P, near = (x, y) => P.reduce((b, p) => Math.hypot(p.px - x, p.py - y) < Math.hypot(b.px - x, b.py - y) ? p : b).i;
      for (const a of P) for (const b of P) { const d = Math.hypot(a.px - b.px, a.py - b.py); if (a.i >= b.i || d < 6 || d > 18) continue;
        const pos = t => [a.px + (b.px - a.px) * t, a.py + (b.py - a.py) * t];
        if (near(...pos(.3)) === a.i && near(...pos(.7)) === b.i) return [a.i, b.i]; }
      return null; }, C);
    if (!pair) bad("no two close points to test the nearest-point rule on");
    else for (const [t, want] of [[.3, pair[0]], [.7, pair[1]]]) {
      await page.mouse.move(...await at(pair[0], [pair[1], t]));
      const got = (await ui()).hov;
      if (got !== want) bad(`pointer ${t} of the way from point ${pair[0]} to ${pair[1]} got point ${got}, expected ${want}`);
    }
    await away();
    await page.evaluate(() => { effChange(effPreset("default")); state.cmp = window.__cmp; delete window.__cmp; renderEffLines(); });
    await page.setViewportSize(vp);
  }
  /* ---------- effort-line charts (end) ---------- */

  for (const theme of ["dark", "light"]) await page.click(`.themesw button[data-t="${theme}"]`);
  console.log(`${rows} board rows · ${nm} models · ASOF ${asof}`);
} finally {
  await browser.close();
  server.close();
}
for (const p of problems) console.log("FAIL  " + p);
console.log(problems.length ? `${problems.length} problem(s)` : "smoke test passed");
process.exit(problems.length ? 1 : 0);
