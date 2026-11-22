#!/usr/bin/env node
/* Headless-Chromium smoke test for index.html: serves the repo over local HTTP,
   exercises every tab, both pricing lenses, keyboard navigation and responsive
   layouts, and checks the header against the data. Uses an existing playwright / playwright-core install
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
const nPlans = (html.slice(html.indexOf("const PLANS"), html.indexOf("const CHANGELOG")).match(/\{id:"/g) || []).length;

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

  if (!(await page.evaluate(() => document.doctype?.name === "html" && document.compatMode === "CSS1Compat"))) problems.push("the page does not use HTML standards mode");
  if (!(await page.locator('html[lang="en"] head > style').count()) || !(await page.locator("h1").count())) problems.push("the HTML shell lacks English language, head styles, or a main heading");
  const tabs = page.locator(".tabs[role=tablist] [role=tab]");
  const wired = await tabs.evaluateAll(ts => ts.length === 5 && ts.every(t => {
    const panel = document.getElementById(t.getAttribute("aria-controls"));
    return panel?.getAttribute("role") === "tabpanel" && panel.getAttribute("aria-labelledby") === t.id;
  }));
  if (!wired) problems.push("the five tabs are not wired to their labelled panels");
  await page.locator("#t-board").focus();
  for (const [key, id] of [["ArrowRight", "subs"], ["Home", "board"]]) {
    await page.keyboard.press(key);
    const active = await page.evaluate(id => {
      const t = document.getElementById("t-" + id);
      return document.activeElement === t && t.matches('[aria-selected=true][tabindex="0"]')
        && !!document.querySelector("#p-" + id + ".on")
        && document.querySelectorAll('.tabs [aria-selected=true], .panel.on').length === 2
        && document.querySelectorAll('.tabs [tabindex="0"]').length === 1;
    }, id);
    if (!active) problems.push(`${key} did not activate and focus the ${id} tab`);
  }

  const rows = await page.locator("#board tbody tr[data-m]").count();
  if (!rows) problems.push("Board table has no rows");
  const asof = await page.textContent("#asof"), nm = await page.textContent("#nmodels");
  if (asof !== ASOF) problems.push(`header ASOF "${asof}" ≠ "${ASOF}"`);
  if (+nm !== nModels) problems.push(`header model count ${nm} ≠ ${nModels}`);
  if (!(await page.locator("footer.foot").count())) problems.push("footer is missing");
  const boardNames = () => page.locator("#board tbody tr[data-m]").evaluateAll(rs => rs.map(r => r.dataset.m));
  await page.fill("#q", "OpenAI");
  const openai = await boardNames();
  await page.fill("#q", "OpenAI ");
  if (!openai.length || JSON.stringify(await boardNames()) !== JSON.stringify(openai)) problems.push("trailing space changed the OpenAI search results");
  const previous = await page.evaluate(() => MODELS.find(m => m.tier === "legacy" && !ARCHIVE.has(m.name))?.name);
  if (!previous) problems.push("no non-archived Previous gen model to test");
  else {
    await page.fill("#q", previous);
    if ((await boardNames()).includes(previous) || !/match(es)? in previous-generation models/.test(await page.textContent("#archnote"))) problems.push("the Board search did not identify the hidden Previous gen match");
    if (await page.locator("#legbtn").count()) {
      await page.click("#legbtn");
      if (!(await boardNames()).includes(previous)) problems.push("Show previous gen did not reveal the searched model");
      await page.locator("#tierchips").getByRole("button", { name: "Previous gen", exact: true }).click();
    }
  }
  await page.fill("#q", "");
  // the Archive: hidden by default, no plan's model in it, and one button shows and hides it again
  {
    const nArch = await page.evaluate(() => ARCHIVE.size);
    const planned = await page.evaluate(() => PLANS.flatMap(p => Object.keys(p.models)).filter(n => ARCHIVE.has(n)));
    if (planned.length) problems.push(`models a plan includes are archived: ${planned.join(", ")}`);
    if (nArch) {
      if (await page.locator("#board tbody tr[data-m]").evaluateAll(trs => trs.some(t => ARCHIVE.has(t.dataset.m)))) problems.push("archived models show on the default Board");
      await page.click("#archbtn");
      const shownAll = await page.locator("#board tbody tr[data-m]").evaluateAll(trs => trs.filter(t => ARCHIVE.has(t.dataset.m)).length);
      if (shownAll !== nArch) problems.push(`Show the Archive brought back ${shownAll} of ${nArch} archived models`);
      await page.click("#archbtn");
      if ((await page.locator("#board tbody tr[data-m]").count()) !== rows) problems.push("Hide the Archive did not restore the default Board");
      // a search that only archived models match says so
      const arch1 = await page.evaluate(() => [...ARCHIVE][0]);
      await page.fill("#q", arch1);
      if (!/match(es)? in archived models/.test(await page.textContent("#archnote"))) problems.push(`searching "${arch1}" does not point to the archived match`);
      await page.fill("#q", "");
    }
  }
  // under the subscription lens a plan cell says what that plan reaches when it is below the model's best
  {
    const lower = await page.evaluate(() => MODELS.filter(m => m.tier !== "archive" && val(m, "aaii") != null).map(m => { const p = cheapPlan(m.name), q = p && planReach(p, m); return q && q.r.aaii < val(m, "aaii") ? [m.name, q.r.aaii] : null; }).filter(Boolean)[0]);
    if (lower) {
      const cell = await page.locator(`#board tbody tr[data-m="${lower[0]}"] .pl.reach`).textContent().catch(() => "");
      if (!cell.includes(`Index ${lower[1]}`)) problems.push(`${lower[0]}'s plan cell does not say its plan reaches Index ${lower[1]}`);
    }
  }
  // keyboard: a model name and a column heading are buttons, Enter works, and focus stays put after the re-render
  {
    const first = page.locator("#board tbody tr[data-m] .rowbtn").first(), name = await page.locator("#board tbody tr[data-m]").first().getAttribute("data-m");
    await first.focus(); await page.keyboard.press("Enter");
    if (!(await page.locator("#board tbody tr.det").count())) problems.push("Enter on a model name did not open its details");
    if ((await page.evaluate(() => document.activeElement?.closest("tr")?.dataset.m)) !== name) problems.push("focus left the model name after opening its details");
    if ((await page.locator(`#board tbody tr[data-m="${name}"] .rowbtn`).getAttribute("aria-expanded")) !== "true") problems.push("the opened row's button is not aria-expanded");
    await page.keyboard.press("Enter");
    await page.locator('#board thead th[data-k="name"] .thbtn').focus(); await page.keyboard.press("Enter");
    if ((await page.locator('#board thead th[data-k="name"]').getAttribute("aria-sort")) !== "ascending") problems.push("Enter on the Model heading did not sort by name");
    if ((await page.evaluate(() => document.activeElement?.closest("th")?.dataset.k)) !== "name") problems.push("focus left the heading after sorting");
    await page.evaluate(() => { state.sort = "aaii"; state.dir = -1; render(); });
  }
  // the coverage grid: a model name opens its scores as text from the keyboard
  {
    await page.click('.tab[data-p="bench"]');
    await page.locator("#benchhost .covbtn").first().focus(); await page.keyboard.press("Enter");
    if (!(await page.locator("#benchhost .covdet li").count())) problems.push("Enter on a coverage-grid model listed no scores");
    if (!(await page.evaluate(() => document.activeElement?.classList.contains("covbtn")))) problems.push("focus left the coverage-grid model after opening it");
    await page.keyboard.press("Enter");
    await page.click('.tab[data-p="board"]');
  }
  // the model filters show only where they apply, and a tab picked after scrolling opens at its top
  {
    await page.evaluate(() => scrollTo(0, 2500));
    await page.click('.tab[data-p="subs"]');
    if (await page.locator("#q").isVisible()) problems.push("the model search shows on the Subscriptions tab, where it filters nothing");
    if (!(await page.locator("#minechip").isVisible())) problems.push("Pick my plans is hidden on the Subscriptions tab");
    const top = await page.evaluate(() => document.querySelector("#p-subs").getBoundingClientRect().top);
    if (top < 0) problems.push(`the Subscriptions tab opened ${Math.round(-top)}px below its top`);
    await page.click('.tab[data-p="src"]');
    if (await page.locator(".rail").isVisible()) problems.push("the filter bar shows on the Sources tab");
    for (const id of ["caveats-h", "srclist-h", "planlist-h"]) if (!(await page.locator(`.jumps a[href="#${id}"]`).count()) || !(await page.locator(`#${id}`).count())) problems.push(`Sources has no working jump link to #${id}`);
    await page.click('.tab[data-p="board"]');
    if (!(await page.locator("#q").isVisible())) problems.push("the model search did not come back on the Board");
  }

  await page.locator("#board tbody tr[data-m]").first().click();
  if (!(await page.locator("#board .detbox").count())) problems.push("clicking a row did not open its detail panel");

  for (const t of ["subs", "quad", "bench", "src", "board"]) {
    await page.click(`.tab[data-p="${t}"]`);
    const on = await page.locator(`#p-${t}.on`).count();
    if (!on) problems.push(`tab ${t} did not open`);
  }
  if (!(await page.locator("#c-index svg").count())) problems.push("Charts tab rendered no Intelligence Index chart");
  if (!(await page.locator("#benchhost .card").count())) problems.push("Benchmarks tab rendered no cards");
  if (!(await page.locator("#caveats .srccard").count())) problems.push("Sources tab rendered no caveats");
  if (!(await page.locator("#planlist .srccard").count())) problems.push("Sources tab rendered no subscription plan sources");
  const sourceCount = await page.evaluate(() => Object.keys(BENCH).length);
  if ((await page.locator("#srclist .srccard").count()) !== sourceCount) problems.push(`Sources does not list all ${sourceCount} benchmarks`);

  /* ---------- subscriptions: the tab, the visitor's plans, the pricing lens (begin) ---------- */
  {
    const bad = m => problems.push("subscriptions: " + m);
    const pressed = (s, v) => page.getAttribute(s, "aria-pressed").then(a => a === v);
    await page.click('.tab[data-p="subs"]');
    if ((await page.locator("#plantab tbody tr[data-plan]").count()) !== nPlans) bad(`plan table does not have ${nPlans} rows`);
    if ((await page.locator("#sbpick .chip").count()) !== nPlans) bad(`plan picker does not have ${nPlans} chips`);
    for (const c of ["#c-sbladder", "#c-sbuse", "#c-sbtier"]) if (!(await page.locator(`${c} svg`).count())) bad(`${c} drew no chart`);
    if (!(await page.locator("#c-sbladder .frontline").count())) bad("the plan chart has no Pareto frontier");
    if (await page.locator("#c-sbladder .ring").count()) bad("the plan chart rings a plan as yours before any plan is picked");
    if (!(await page.locator("#c-sbuse .frontline").count())) bad("the model-and-effort chart has no Pareto frontier");
    if (!(await page.textContent("#sbuse-front")).includes("→")) bad("the model-and-effort chart lists no frontier settings");
    // every plan must chart without an error, and say so when nothing it offers has been measured
    const each = await page.evaluate(() => PLANS.map(p => { state.subPlan = p.id; renderUse();
      return document.querySelector("#c-sbuse svg") || document.querySelector("#c-sbuse .empty") ? null : p.id; }).filter(Boolean));
    if (each.length) bad(`these plans drew neither a chart nor a notice: ${each.join(", ")}`);
    await page.evaluate(() => { state.subPlan = null; renderUse(); });
    // the budget shortlist: three answer cards, a bigger budget never lowers the winner, the budget travels in the link
    if ((await page.locator("#sbcards .sb-card").count()) !== 3) bad("the ≤$20 budget does not show three answer cards");
    const winAt = async c => { await page.click(`#sbbudget [data-cap="${c}"]`); return +(await page.textContent("#sbcards .sb-card.win .sb-ix b")); };
    const w20 = await winAt(20), wAny = await winAt("Infinity");
    if (!(wAny >= w20)) bad(`the Any budget's winner (Index ${wAny}) scores below the ≤$20 winner (${w20})`);
    if (!page.url().includes("budget=any")) bad("the budget is not in the URL");
    await page.click('#sbbudget [data-cap="20"]');
    // two plans to compare: the tray, then a sheet with both plans and their effort levels; Escape and a tab switch close it
    const cmpIds = await page.$$eval("#sbcards [data-sbcmp]", bs => bs.slice(0, 2).map(b => b.dataset.sbcmp));
    await page.click(`#sbcards [data-sbcmp="${cmpIds[0]}"]`);
    if (!(await page.locator("#sbgo").evaluate(b => {
      const s = getComputedStyle(b);
      return b.disabled && (+s.opacity < 1 || s.cursor === "not-allowed");
    }))) bad("the disabled Compare button has no disabled styling");
    await page.click(`#sbcards [data-sbcmp="${cmpIds[1]}"]`);
    if (!(await page.locator("#sbtray").isVisible())) bad("picking two plans to compare shows no compare tray");
    await page.click("#sbgo");
    if (!(await page.locator("#sbsheet").isVisible())) bad("the compare sheet did not open");
    if ((await page.locator("#sbgrid .gh").count()) !== 2) bad("the compare sheet does not show the two plans");
    if (!(await page.locator("#sbgrid .sb-eff i").count())) bad("the compare sheet draws no effort levels");
    // the sheet is modal: Tab and Shift+Tab stay inside it
    const inSheet = () => page.evaluate(() => document.querySelector(".sb-sheetin").contains(document.activeElement));
    await page.keyboard.press("Shift+Tab");
    if (!(await inSheet())) bad("Shift+Tab from the compare sheet's Close button left the sheet");
    await page.keyboard.press("Tab");
    if (!(await inSheet())) bad("Tab from the compare sheet's last control left the sheet");
    await page.keyboard.press("Escape");
    if (await page.locator("#sbsheet").isVisible()) bad("Escape did not close the compare sheet");
    await page.click("#sbgo");
    await page.evaluate(() => document.querySelector('.tab[data-p="board"]').click());
    if (await page.evaluate(() => !document.querySelector("#sbsheet").hidden)) bad("switching tabs left the compare sheet open");
    await page.click('.tab[data-p="subs"]');
    await page.click("#sbclr");
    if (await page.locator("#sbtray").isVisible()) bad("clearing the comparison left the tray up");
    // a row opens its detail with a link to the vendor's page
    await page.click("#sbd-all > summary");
    const head = page.locator('#plantab th[data-k="idx"]');
    await head.locator(".thbtn").press("Enter");
    if (await head.getAttribute("aria-sort") !== "descending" || !(await head.locator(".thbtn").evaluate(b => document.activeElement === b))) bad("Enter did not sort plans by Index and retain focus");
    const first = page.locator("#plantab tbody tr[data-plan]").first(), pid = await first.getAttribute("data-plan");
    const planRow = page.locator(`#plantab tr[data-plan="${pid}"]`);
    await planRow.locator(".rowbtn").press("Enter");
    if (await planRow.locator(".rowbtn").getAttribute("aria-expanded") !== "true" || !(await planRow.locator(".rowbtn").evaluate(b => document.activeElement === b))) bad("Enter did not expand the plan row and retain focus");
    const href = await page.locator("#plantab .detbox .dsrc a").getAttribute("href").catch(() => null);
    if (!href || !href.startsWith("https://")) bad("an opened plan row shows no source link");
    await planRow.locator(".rowbtn").press("Enter");
    if (await planRow.locator(".rowbtn").getAttribute("aria-expanded") !== "false") bad("Enter did not collapse the plan row");
    const have = planRow.locator(".have");
    for (const on of ["true", "false"]) {
      await have.press("Enter");
      if (await have.getAttribute("aria-pressed") !== on || !(await have.evaluate(b => document.activeElement === b))) bad("toggling a plan with the keyboard did not update its button and retain focus");
    }
    // picking a plan: the chip, the summary, the URL, the Board marks and the filter
    await page.click("#sbpickb");
    await page.click(`#sbpick [data-plan="${pid}"]`);
    if (!(await pressed(`#sbpick [data-plan="${pid}"]`, "true"))) bad("a picked plan chip is not pressed");
    if (!page.url().includes(`plans=${pid}`)) bad(`picking a plan did not put plans=${pid} in the URL`);
    if (!(await page.textContent("#sbsum")).includes("a month")) bad("the summary does not total the picked plans");
    const nIn = await page.evaluate(id => Object.keys(PLANS.find(p => p.id === id).models).length, pid);
    await page.click('.tab[data-p="board"]');
    if (!(await page.locator("#board thead th[data-k='plan']").count())) bad("the Board has no plan column under the subscription lens");
    if (!(await page.locator("#board .mine").count())) bad("the Board marks no model as in the picked plan");
    await page.evaluate(() => { state.tiers = new Set(["frontier", "challenger", "legacy"]); });
    await page.click("#minechip");
    const shown = +(await page.textContent("#shown"));
    if (shown !== nIn) bad(`In my plans shows ${shown} models, the plan has ${nIn}`);
    if (!page.url().includes("mine=1")) bad("the In my plans filter is not in the URL");
    // opening a model the plan leaves out clears the filter, and the URL must say so too
    const outside = await page.evaluate(id => MODELS.find(m => m.tier !== "legacy" && !(m.name in PLANS.find(p => p.id === id).models)).name, pid);
    await page.evaluate(n => openModel(n), outside);
    if (page.url().includes("mine=1")) bad("opening a model outside the picked plans cleared the filter but left mine=1 in the URL");
    await page.click("#minechip");
    if (!page.url().includes("mine=1")) bad("the In my plans filter is not in the URL after it is turned back on");
    await page.click("#minechip");
    await page.evaluate(() => { state.tiers = new Set(["frontier", "challenger"]); render(); });
    // the link restores the plans in a fresh page
    const again = await browser.newPage();
    await again.goto(url + `?tab=subscriptions&budget=&plans=${pid},not-a-plan&plan=muse-power`, { waitUntil: "load" });
    if ((await again.evaluate(() => [...state.mine].join())) !== pid) bad("a link's plans= did not restore the picked plans, or kept an unknown id");
    if ((await again.inputValue("#sbplan")) !== "muse-power") bad("a link's plan= did not select that plan");
    if (await again.getAttribute('#sbbudget [data-cap="20"]', "aria-pressed") !== "true") bad("empty budget= did not retain the default budget");
    const legend = await again.evaluate(() => {
      const plan = PLANS.find(p => p.id === "muse-power");
      const expected = [...new Set(planPts(plan).filter(q => q.r.cost > 0).map(q => q.m.name))].sort();
      const shown = [...document.querySelectorAll("#sbmodels > span")].map(e => e.textContent).sort();
      return expected.length && !expected.includes("Muse Wonder Full") && shown.join("|") === expected.join("|");
    });
    if (!legend) bad("the usage chart legend does not match the models with measured cost");
    await again.close();
    // a link from before the lens existed that names an API-price chart still lands on it
    for (const old of ["?tab=charts&chart=price", "#ch-ppp"]) {
      const o = await browser.newPage();
      await o.goto(page.url().replace(/[?#].*$/, "") + old, { waitUntil: "load" });
      if (!(await o.locator("#ch-" + old.replace(/.*[=-]/, "")).isVisible())) bad(`the older link ${old} opens with its chart hidden`);
      await o.close();
    }
    // the pricing lens: API brings back the blended price column and the API-price charts
    await page.click('#lens [data-v="api"]');
    if (!(await page.locator("#board thead th[data-k='price']").count()) || (await page.locator("#board thead th[data-k='plan']").count())) bad("the API lens does not swap the plan column for the blended price");
    if (!page.url().includes("lens=api")) bad("the API lens is not in the URL");
    // Give two candidates the same lowest price, with the lower Index first in both data and name order.
    const tied = await page.evaluate(() => {
      const candidates = MODELS.filter(m => !["legacy", "archive"].includes(m.tier) && m.s.aaii && m.s.price);
      const low = candidates[0], high = candidates.find(m => m.name.localeCompare(low.name) > 0);
      if (!high) return false;
      const top = Math.max(...MODELS.map(m => val(m, "aaii") ?? 0));
      const saved = [low, high].map(m => [m.s.aaii, m.s.price]);
      try {
        for (const [i, m] of [low, high].entries()) {
          m.s.aaii = [top + i + 1, "ind"];
          m.s.price = [0, "ven"];
        }
        renderPicks();
        return [...document.querySelectorAll("#picks .pick")].find(b => b.querySelector(".pl").textContent === "Near the top for less")?.dataset.m === high.name;
      } finally {
        [low, high].forEach((m, i) => { [m.s.aaii, m.s.price] = saved[i]; });
        renderPicks();
      }
    });
    if (!tied) bad("the API Board's value pick did not prefer the higher Index at equal prices");
    const coding = await page.locator("#picks .pick").filter({ hasText: "Coding & agents" }).getAttribute("title");
    if (!coding || /vendor-run/i.test(coding)) bad("the API Board's Coding & agents tooltip misstates provenance");
    await page.click('.tab[data-p="quad"]');
    for (const c of ["#ch-price", "#ch-blend", "#ch-ppp"]) if (!(await page.locator(c).isVisible())) bad(`${c} is hidden under the API lens`);
    // an API-only chart named in the URL is dropped when the lens it needs is switched off
    await page.click('#jump a[href="#ch-ppp"]');
    if (!page.url().includes("chart=ppp")) bad("following the Price of a point jump link did not put chart=ppp in the URL");
    // read the URL in the same task as the click: a later scroll event can hide the bug by re-tracking the section
    const afterLens = await page.evaluate(() => { document.querySelector('#lens [data-v="sub"]').click(); return location.search; });
    if (/chart=(price|blend|ppp)/.test(afterLens)) bad(`switching to the subscription lens left an API-only chart in the URL: ${afterLens}`);
    for (const c of ["#ch-price", "#ch-blend", "#ch-ppp"]) if (await page.locator(c).isVisible()) bad(`${c} is shown under the subscription lens`);
    if (!(await page.locator('#cmpgroups [data-g="mine"]').count())) bad("the effort charts offer no My plans group once a plan is picked");
    // leave the page as it was found: no plans, subscription lens, Board tab
    await page.evaluate(id => { planToggle(id); try { localStorage.removeItem("fb-plans"); localStorage.removeItem("fb-lens"); } catch (e) {} }, pid);
    await page.click('.tab[data-p="board"]');
    if (/plans=|lens=|mine=/.test(page.url())) bad(`clearing the plans left "${page.url().split("?")[1] || ""}" in the URL`);
  }
  /* ---------- subscriptions (end) ---------- */

  // Wide charts should preserve the scale of their marks when a card has spare room.
  const svgScale = svg => svg.getBoundingClientRect().width / svg.viewBox.baseVal.width;
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.click("#t-quad");
  if (await page.locator("#ch-ctx svg").evaluate(svgScale) > 1.5) problems.push("monthly-plan Context chart is inflated over 1.5×");
  const group = page.locator("#c-ctx [data-grp]").first();
  if (await group.getAttribute("tabindex") !== "0") problems.push("Context groups are not in the keyboard tab order");
  const expanded = await group.evaluate(g => {
    g.focus({ preventScroll: true });
    const showedTip = document.querySelector("#tip").classList.contains("on");
    g.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    const next = document.querySelector(`#c-ctx [data-grp="${g.dataset.grp}"]`);
    return showedTip && next?.getAttribute("aria-expanded") === "true" && document.activeElement === next
      && !document.querySelector("#tip").classList.contains("on");
  });
  if (!expanded) problems.push("Enter on a Context group did not expand it, retain focus and dismiss its tooltip");
  const hash = await page.evaluate(() => new Promise(resolve => {
    addEventListener("hashchange", () => resolve({
      chart: new URLSearchParams(location.search).get("chart"), visible: !!document.querySelector("#ch-price").getClientRects().length
    }), { once: true });
    location.hash = "ch-price";
  }));
  if (hash.chart === "price" && !hash.visible) problems.push("hash navigation left chart=price in the URL with its chart hidden");
  await page.goto(url + "?tab=charts&chart=price&lens=sub", { waitUntil: "load" });
  if (new URL(page.url()).searchParams.get("chart") === "price" || await page.locator("#ch-price").isVisible()) problems.push("an explicit monthly-plan link retained the API price chart");
  await page.click("#t-bench");
  // Give one real benchmark card a full row to reproduce the wide-card layout.
  const benchmarkBar = p => p.locator('#benchhost [data-bench-bars="aaii"] svg');
  const singleBar = benchmarkBar(page);
  await singleBar.evaluate(svg => { svg.closest(".card").style.gridColumn = "1 / -1"; });
  if (await singleBar.evaluate(svgScale) > 1.5) problems.push("single-card Benchmarks chart is inflated over 1.5×");

  /* ---------- effort-line charts: drawing, point details, hit testing (begin) ---------- */
  {
    const bad = m => problems.push("effort lines: " + m);
    const C = "#c-effcost", vp = page.viewportSize();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.click('.tab[data-p="quad"]');
    await page.waitForTimeout(300); // the debounced resize re-render
    // desktop: the waiting-time chart has its own button, which moves the shared controls next to it and back
    {
      const shown = await page.evaluate(() => [...document.querySelectorAll(".cmpmove")].filter(b => b.offsetParent).map(b => b.closest(".card").id).join());
      if (shown !== "ch-efflat") bad(`Edit compared models shows on "${shown}", expected only the waiting-time chart`);
      await page.click("#ch-efflat .cmpmove");
      if ((await page.evaluate(() => document.querySelector("#cmp").closest(".card").id)) !== "ch-efflat") bad("Edit compared models did not bring the controls to the waiting-time chart");
      if ((await page.evaluate(() => document.activeElement?.id)) !== "effq") bad("Edit compared models did not focus the model search");
      await page.click("#ch-effcost .cmpmove");
      if ((await page.evaluate(() => document.querySelector("#cmp").closest(".card").id)) !== "ch-effcost") bad("the controls did not move back to the cost chart");
    }
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
    await page.waitForTimeout(400); // let the section tracker write the scrolled-to chart into the URL first
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

    // a default comparison link opens the default picks even for a visitor whose own saved picks differ (page a's storage holds custom picks)
    const own = await a.evaluate(k => localStorage.getItem(k), "fb-effpick");
    if (!own || own === JSON.stringify(def.picks.split("|"))) problems.push("test setup: page a's custom picks were not saved, so the shared-link check proves nothing");
    await a.goto(url + "?tab=charts", { waitUntil: "load" });
    const D = await snap(a);
    if (D.picks !== def.picks) problems.push(`?tab=charts opened the visitor's saved picks "${D.picks}" instead of the defaults "${def.picks}"`);
    await a.close();

    // phone: once scrolled only the tab row and a one-line filter bar stay pinned, and the filters open behind one button
    {
      const ph = await fresh(url, { width: 390, height: 844 });
      await ph.evaluate(() => scrollTo(0, 1600)); await ph.waitForTimeout(200);
      const pin = await ph.evaluate(() => ({ rail: document.querySelector(".rail").getBoundingClientRect().bottom, tabs: document.querySelector(".tabs").getBoundingClientRect().top }));
      if (!(pin.rail <= 140)) problems.push(`phone: the pinned header and filters end ${Math.round(pin.rail)}px down, over 140`);
      if (!(pin.tabs >= -1)) problems.push("phone: the tab row scrolled out of view");
      if (await ph.locator("#tierchips").isVisible()) problems.push("phone: the tier chips show before Filters is opened");
      await ph.click("#railtog");
      if (!(await ph.locator("#tierchips").isVisible()) || (await ph.getAttribute("#railtog", "aria-expanded")) !== "true") problems.push("phone: Filters did not open the filter panel");
      // the compact Board fits the screen with model, Index and plan together; the button brings every column back
      const fit = await ph.evaluate(() => ({ wrap: document.querySelector(".tablewrap").clientWidth, table: document.querySelector("#board").scrollWidth, cols: [...document.querySelectorAll("#board thead th")].filter(t => t.offsetParent).length }));
      if (fit.table > fit.wrap + 1) problems.push(`phone: the compact Board is ${fit.table}px wide in a ${fit.wrap}px frame`);
      if (fit.cols !== 4) problems.push(`phone: the compact Board shows ${fit.cols} columns, expected rank, model, Index and plan`);
      // an opened row's own tables (the effort levels) keep their headings in the compact view
      const multi = await ph.evaluate(() => Object.keys(EFFORT).find(n => EFFORT[n].length > 1 && document.querySelector(`#board tbody tr[data-m="${n}"]`)));
      if (multi) {
        await ph.locator(`#board tbody tr[data-m="${multi}"] .rowbtn`).click();
        const hidden = await ph.evaluate(() => [...document.querySelectorAll("#board tr.det th")].filter(t => !t.offsetParent).length);
        if (hidden) problems.push(`phone: ${hidden} headings in ${multi}'s details are hidden by the compact Board`);
        const detailsFit = await ph.locator("#board .efftab").evaluate(t => {
          const wrap = t.closest(".tablewrap"), d = t.closest(".detbox").getBoundingClientRect(), r = t.getBoundingClientRect();
          const cell = getComputedStyle(t.closest("tr.det > td"));
          return { frame: wrap.clientWidth, board: wrap.scrollWidth, detail: [d.left, d.right], table: [r.left, r.right],
            cellPadding: [cell.paddingLeft, cell.paddingRight] };
        });
        const { frame, board, detail, table } = detailsFit;
        if (board > frame + 1 || table[0] < detail[0] - 1 || table[1] > detail[1] + 1 || table[1] <= table[0]) problems.push(`phone: expanded effort table extends beyond its details or Board frame: ${JSON.stringify(detailsFit)}`);
        await ph.locator(`#board tbody tr[data-m="${multi}"] .rowbtn`).click();
      } else problems.push("phone: no multi-effort model to expand");
      const inlinePrices = await ph.locator("#board td:has(> .pl) > .q.ven").evaluateAll(dots => dots.length && dots.every(dot => {
        const price = document.createRange();
        price.selectNode(dot.previousSibling);
        const r = price.getBoundingClientRect(), mark = dot.getBoundingClientRect();
        return mark.top < r.bottom && mark.bottom > r.top && mark.left >= r.right - 1;
      }));
      if (!inlinePrices) problems.push("phone: Board plan price and provenance dot are not inline");
      await ph.click("#boardcols");
      if ((await ph.evaluate(() => [...document.querySelectorAll("#board thead th")].filter(t => t.offsetParent).length)) <= 4) problems.push("phone: Show every column did not bring the other columns back");
      await ph.click("#t-bench");
      await ph.locator("#benchhost .archive > summary").click();
      const coverage = await ph.evaluate(() => {
        const wrap = document.querySelector(".covwrap");
        wrap.scrollTop = 120;
        const before = wrap.scrollTop;
        wrap.querySelectorAll(".covbtn")[6].click();
        const next = document.querySelector(".covwrap"), list = next.querySelector(".covlist");
        return { before, after: next.scrollTop, archive: document.querySelector("#benchhost .archive").open,
          fits: !!list && list.getBoundingClientRect().width <= next.clientWidth + 1 && list.scrollWidth <= list.clientWidth + 1 };
      });
      if (!coverage.before || coverage.before !== coverage.after || !coverage.archive || !coverage.fits) problems.push(`phone: coverage expansion lost scroll, archive state or fit: ${JSON.stringify(coverage)}`);
      const bar = benchmarkBar(ph);
      if (await bar.count()) {
        const usable = await bar.evaluate(svg => {
          const r = svg.getBoundingClientRect();
          return r.width >= 240 && r.right <= innerWidth + 1;
        });
        if (!usable) problems.push("phone: single-card benchmark chart is too narrow or extends off screen");
        const tipResult = await bar.evaluate(svg => {
          const mark = svg.querySelector("[data-tip]"), tip = document.querySelector("#tip");
          mark.dispatchEvent(new MouseEvent("mouseenter", { clientX: innerWidth - 2, clientY: 200 }));
          const r = tip.getBoundingClientRect(), clamped = r.left >= 0 && r.right <= innerWidth;
          const shown = tip.classList.contains("on");
          // Change tabs without moving the pointer off the mark first.
          document.querySelector("#t-src").click();
          return shown && clamped && !tip.classList.contains("on");
        });
        if (!tipResult) problems.push("phone: global chart tooltip did not stay on screen or dismiss on tab switch");
      } else problems.push("phone: no single-card benchmark chart to measure");
      await ph.close();
      // the comparison sheet groups by attribute on a phone, so neither plan is cut off
      const ps = await fresh(url + "?tab=subscriptions", { width: 390, height: 844 });
      await ps.evaluate(() => { state.subCmp.add("claude-pro"); state.subCmp.add("chatgpt-plus"); renderShort(); sbSheet.show(); });
      const sh = await ps.evaluate(() => { const g = document.querySelector("#sbgrid"); return { grouped: g.classList.contains("bya"), over: g.scrollWidth - g.clientWidth, names: g.querySelectorAll(".gpn").length }; });
      if (!sh.grouped || sh.over > 1 || sh.names < 4) problems.push(`phone: the comparison sheet is not grouped by attribute or overflows: ${JSON.stringify(sh)}`);
      // the folded limits and sources are reachable from the keyboard inside the sheet's focus trap
      let reached = false;
      for (let i = 0; i < 12 && !reached; i++) { await ps.keyboard.press("Tab"); reached = await ps.evaluate(() => document.activeElement?.tagName === "SUMMARY"); }
      if (!reached) problems.push("phone: Tab never reaches 'Limits, overage and sources' in the comparison sheet");
      else { await ps.keyboard.press("Enter"); if (!(await ps.evaluate(() => document.querySelector("#sbgrid .gmore").open))) problems.push("phone: Enter did not open 'Limits, overage and sources'"); }
      await ps.evaluate(() => {
        window.heightCheck = new Promise(resolve => {
          addEventListener("resize", () => resolve(document.querySelector("#sbgrid .gmore")?.open), { once: true });
        });
      });
      await ps.setViewportSize({ width: 390, height: 740 });
      if (reached && !(await ps.evaluate(() => window.heightCheck))) problems.push("phone: height-only resize collapsed the comparison limits");
      await ps.setViewportSize({ width: 820, height: 1024 });
      await ps.goto(url + "?tab=subscriptions", { waitUntil: "load" });
      await ps.evaluate(() => {
        state.subCmp = new Set(["claude-pro", "chatgpt-plus", "muse-power", PLANS.find(p => p.fam === "google").id]);
        renderShort();
        sbSheet.show();
      });
      const tablet = await ps.evaluate(() => {
        const grid = document.querySelector("#sbgrid"), sheet = grid.closest(".sb-sheetin");
        const names = new Set([...grid.querySelectorAll(":scope > .gh, :scope > .gp > .gpn")].map(e => e.firstChild.textContent));
        const dots = [...grid.querySelectorAll(".sb-eff [data-tip]")].filter(e => /Muse Wonder Full/.test(e.dataset.tip));
        return { gridOverflow: grid.scrollWidth - grid.clientWidth, sheetOverflow: sheet.scrollWidth - sheet.clientWidth,
          four: names.size === 4,
          unmeasured: dots.length > 0 && dots.every(e => /Cost not measured/.test(e.dataset.tip) && !/A lighter setting scores as high/.test(e.dataset.tip)) };
      });
      if (!tablet.four || tablet.gridOverflow > 1 || tablet.sheetOverflow > 1) problems.push(`tablet: the four-plan Compare sheet overflows or is incomplete: ${JSON.stringify(tablet)}`);
      if (!tablet.unmeasured) problems.push("the Compare sheet mislabels the unmeasured Muse Wonder Full setting");
      await ps.close();
    }

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
    if (!(await m.locator(".cmp.open .cmpbody > #efflist:last-child").count())) problems.push("phone: comparison model list does not follow the controls in DOM order");
    await m.locator("#efflist button[aria-pressed='false']").first().click();
    await m.click("#cmpdone");
    const M = await snap(m);
    if (await m.locator("#cmp").isVisible()) problems.push("phone: Done did not close the sheet");
    if (!(await m.locator("#cmp .pickadd > #efflist[hidden]").count())) problems.push("phone: closing comparison did not restore the model list to the search");
    if (+M.count !== +n0 + 1 || await m.textContent("#ch-effcost .cmpopen .cmpn") !== String(+n0 + 1)) problems.push("phone: the Models count did not follow a pick made in the sheet");
    if (M.named !== "effcost" || M.section !== "ch-effcost") problems.push(`phone: after the sheet the section is ${M.named} / ${M.section}, not effcost`);
    // phone: a pinned details card pushes the legend and frontier list down rather than covering them
    for (const pareto of [false, true]) {
      const lay = await m.evaluate(on => {
        state.cmp.pareto = on; renderEffLines();
        const sel = Object.keys(effUI.charts)[0]; effPin(sel, 0);
        const c = effUI.charts[sel], card = c.card.getBoundingClientRect();
        const after = [...c.wrap.children].filter(e => e !== c.plot && e.getClientRects().length).map(e => ({ cls: e.className, top: e.getBoundingClientRect().top }));
        effClose();
        return { shown: !c.card.hidden || card.height > 0, bottom: card.bottom, after };
      }, pareto);
      if (!lay.after.length) problems.push(`phone: no legend under the chart to check (pareto ${pareto})`);
      if (lay.after.length) for (const e of lay.after) if (e.top < lay.bottom - 0.5) problems.push(`phone: pinned card (bottom ${lay.bottom}) covers .${e.cls} (top ${e.top}), pareto ${pareto}`);
    }
    // pressed buttons keep legible text on hover (not overwritten by :not(:disabled):hover specificity)
    for (const sel of ['#tierchips .chip[aria-pressed="true"]', '#lens button[aria-pressed="true"]', '.themesw button[aria-pressed="true"]']) {
      const el = page.locator(sel).first();
      await el.hover();
      const same = await el.evaluate(e => { const s = getComputedStyle(e); return s.color === s.backgroundColor; });
      if (same) problems.push(`hovering pressed control ${sel} turns its text invisible against its background`);
    }
    // narrow phone (360px): brand and theme switcher share row 1
    await m.setViewportSize({ width: 360, height: 800 });
    const row1 = await m.evaluate(() => Math.abs(document.querySelector(".brand").getBoundingClientRect().top - document.querySelector(".themesw").getBoundingClientRect().top));
    if (row1 > 12) problems.push(`360px phone: theme switcher wrapped onto a second row (${Math.round(row1)}px below brand)`);
    await m.close();
  }
  /* ===== comparison controls + shareable URL: end ===== */

  console.log(`${rows} board rows · ${nm} models · ${nPlans} plans · ASOF ${asof}`);
} finally {
  await browser.close();
  server.close();
}
for (const p of problems) console.log("FAIL  " + p);
console.log(problems.length ? `${problems.length} problem(s)` : "smoke test passed");
process.exit(problems.length ? 1 : 0);
