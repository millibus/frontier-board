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

  for (const t of ["quad", "bench", "src", "upd", "board"]) {
    await page.click(`.tab[data-p="${t}"]`);
    const on = await page.locator(`#p-${t}.on`).count();
    if (!on) problems.push(`tab ${t} did not open`);
  }
  if (!(await page.locator("#c-index svg").count())) problems.push("Charts tab rendered no Intelligence Index chart");
  if (!(await page.locator("#benchhost .card").count())) problems.push("Benchmarks tab rendered no cards");
  if (!(await page.locator("#caveats .srccard").count())) problems.push("Sources tab rendered no caveats");

  for (const theme of ["dark", "light"]) await page.click(`.themesw button[data-t="${theme}"]`);
  console.log(`${rows} board rows · ${nm} models · ASOF ${asof}`);
} finally {
  await browser.close();
  server.close();
}
for (const p of problems) console.log("FAIL  " + p);
console.log(problems.length ? `${problems.length} problem(s)` : "smoke test passed");
process.exit(problems.length ? 1 : 0);
