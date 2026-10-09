# Frontier Board

Single-page LLM benchmark aggregator, published with GitHub Pages from `main` (root) at https://millibus.github.io/frontier-board/. Everything the site serves lives in `index.html` (HTML, CSS, JS, data). There is no build step and no dependencies. `.nojekyll` must stay. `scripts/` holds dev-only checks; they are never loaded by the page.

## Data blocks (inside the `<script>` in index.html)

- `ASOF` / `ASOF_NOTE`: snapshot date shown in the header. Bump on every update. `ASOF` must equal the newest `CHANGELOG` date. If an update only corrects text, say so in `ASOF_NOTE` ("Corrections only … data last refreshed …").
- `BENCH`: one entry per benchmark (label, source, url, `asof`, format, `hi` = higher is better, description, optional `warn`/`arch`). Add a `BENCH` entry before using a new benchmark id, and add the id to `BENCH_ORDER`.
  - `asof` is the date of the newest data in that column, not the date the column was created. Bump it whenever you add or change a row from a newer source, e.g. a vendor's launch table or a new Artificial Analysis run. Use `"D Mon YYYY"` (optionally followed by ` · note`), or `"Mon YYYY"` / `"Mon–Mon YYYY"` (read as the last day of the last month) when the day is unknown, or `"undated"` if the source publishes no date. Anything else, including an impossible day like `31 Sep`, fails the check.
  - When a column starts mixing several vendors' tables, change `src` to "Vendor comparison tables".
- `MODELS`: one entry per model: `name`, `prov`, `tier` (frontier/challenger/legacy), `open`, `rel` (YYYY-MM-DD), `note`, and `s`, the scores map.
- `EFFORT`: per-model reasoning-effort rows: `[level, index, cost per task, tok/s, TTFT s]`. The first row must match the model's `aaii` and `costTask`.
- `PRICES`: per-model `{in, out, cr, note}` in $ per 1M tokens.
- `CHANGELOG`: newest first: `{d:"8 Oct 2026", items:[[tag, "text"], ...]}`, where tag is one of `add`, `data`, `rescale`, `move` (tier change) or `feature`.

Each score is `benchId: [value, quality, optional source note]`, where quality is:
- `ind`: independently run (Artificial Analysis, Arena, ARC Prize, Vals AI, Scale, OpenRouter, etc.)
- `ven`: reported by the model's vendor or in a competitor's comparison table. Always mark these `ven`. This includes:
  - context windows (`ctx`), which come from provider docs;
  - any blended `price` the board computes itself from vendor list prices (say so in the note).
- `unv`: found in one place with no upstream citation.

A missing score is omitted, never estimated or guessed.

## Notes and prose

Model notes, `BENCH` descriptions/warnings and `CAVEATS` go stale faster than the numbers.
- Every number in prose must match the tuples on the board. When a score changes, or Artificial Analysis rescales its index, grep the notes for the old number.
- Avoid wording that ages: ranks ("second on WebDev"), "today", "newest", "N days old", promo deadlines. Use dates and values instead.
- Don't claim a figure the model has no tuple for, e.g. an Index score for a model with no `aaii`.

## Updating the board

1. Research new models and independent results: Artificial Analysis, Arena text and WebDev, ARC Prize, OpenRouter τ²-bench, plus vendor announcements (those are `ven`).
2. Never use numbers found only on aggregator sites: llm-stats, benchlm, modelcap, benchgecko, neosignal, localaimaster. This applies to prose (caveats, descriptions) as well as score tuples. Don't cite them at all.
3. Edit the data blocks in `index.html`, including each touched column's `BENCH.asof` and any notes the new numbers contradict.
4. Add a `CHANGELOG` entry (also when nothing changed, as earlier entries do), and bump `ASOF` and `ASOF_NOTE`.
5. Verify before pushing (below).
6. Commit and push to `main`. Pages redeploys automatically.

## Merging a PR

When a change goes through a pull request, the Codex review bot reviews it automatically. Wait for that review to finish before merging: it reacts 👍 when it has no findings, or leaves review threads. Fix or answer each thread first. GitHub won't let the account that opened a PR approve it.

## Verifying

```
node scripts/check-data.mjs    # data consistency, no dependencies
node scripts/smoke.mjs         # headless Chromium: all five tabs, no errors, header matches data
```

- `check-data.mjs` fails on:
  - malformed tuples, unknown ids, `BENCH_ORDER` gaps;
  - names that don't match across `MODELS`/`EFFORT`/`PRICES`, or an EFFORT first row that disagrees with the model's scores;
  - `ASOF` ≠ newest changelog date;
  - an unreadable `asof`, or a model released after its column's `asof`;
  - a note quoting an Index score the model doesn't have;
  - `ctx` not marked `ven`;
  - any banned aggregator name;
  - a missing copyright line.

  It warns on speed claims in notes that differ from the measured speed.
- `smoke.mjs` uses the pre-installed playwright and `/opt/pw-browsers/chromium`; do not run `playwright install`. It serves the repo over local HTTP and ignores blocked Google Fonts requests.
- Both must pass. For visual changes, also screenshot the page in light and dark themes.

## Conventions

- Keep the file a complete standalone page: `<!doctype html>`, `<meta charset="utf-8">`, viewport meta, title in `<head>`.
- Match the surrounding code style. Keep the light/dark theme tokens working.
- Copyright: `© 2026 millibus. All rights reserved.` It appears in the page footer and the README. There is deliberately no LICENSE file; do not add one unless asked.
- The page footer credits the data sources and links to the Sources tab. Keep it. When a new independent evaluator starts supplying scores, add it to the footer list and the README.
