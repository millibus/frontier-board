# Frontier Board

Single-page LLM benchmark aggregator, published with GitHub Pages from `main` (root) at https://millibus.github.io/frontier-board/. Everything lives in `index.html` (HTML, CSS, JS, data). There is no build step and no dependencies. `.nojekyll` must stay.

## Data blocks (inside the `<script>` in index.html)

- `ASOF` / `ASOF_NOTE`: snapshot date shown in the header. Bump on every update.
- `BENCH`: one entry per benchmark (label, source, url, snapshot date, format, `hi` = higher is better, description, optional `warn`/`arch`). Add a `BENCH` entry before using a new benchmark id, and add the id to `BENCH_ORDER`.
- `MODELS`: one entry per model: `name`, `prov`, `tier` (frontier/challenger/legacy), `open`, `rel` (YYYY-MM-DD), `note`, and `s`, the scores map.
- `EFFORT`: per-model reasoning-effort rows: `[level, index, cost per task, tok/s, TTFT s]`.
- `PRICES`: per-model `{in, out, cr, note}` in $ per 1M tokens.
- `CHANGELOG`: newest first: `{d:"8 Oct 2026", items:[["add"|"data"|"rescale", "text"], ...]}`.

Each score is `benchId: [value, quality, optional source note]`, where quality is:
- `ind`: independently run (Artificial Analysis, Arena, ARC Prize, Vals AI, Scale, OpenRouter, etc.)
- `ven`: reported by the model's vendor or in a competitor's comparison table. Always mark these `ven`.
- `unv`: found in one place with no upstream citation.

A missing score is omitted, never estimated or guessed.

## Updating the board

1. Research new models and independent results: Artificial Analysis, Arena text and WebDev, ARC Prize, OpenRouter τ²-bench, plus vendor announcements (those are `ven`).
2. Never use numbers found only on aggregator sites: llm-stats, benchlm, modelcap, benchgecko, neosignal, localaimaster.
3. Edit the data blocks in `index.html`.
4. Add a `CHANGELOG` entry (also when nothing changed, as earlier entries do), and bump `ASOF` and `ASOF_NOTE`.
5. Verify before pushing (below).
6. Commit and push to `main`. Pages redeploys automatically.

## Verifying

Open `index.html` in headless Chromium (`/opt/pw-browsers/chromium`, via `playwright-core`; do not run `playwright install`). Click all five tabs and confirm there are no `pageerror` or console errors, the Board table has rows, and the header shows the new `ASOF` and the right model count.

## Conventions

- Keep the file a complete standalone page: `<!doctype html>`, `<meta charset="utf-8">`, viewport meta, title in `<head>`.
- Match the surrounding code style. Keep the light/dark theme tokens working.
- Copyright: `© 2026 millibus. All rights reserved.` There is deliberately no LICENSE file; do not add one unless asked.
