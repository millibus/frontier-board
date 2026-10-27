# Frontier Board — agent instructions

The full project rules are in `CLAUDE.md`. Read it before reviewing or editing anything. This file restates what a reviewer must check, so Codex applies the same rules.

Everything the site serves is in `index.html` (HTML, CSS, JS and the data blocks `ASOF`, `BENCH`, `MODELS`, `EFFORT`, `PRICES`, `CHANGELOG`, `CAVEATS`). There is no build step and there are no dependencies. `scripts/` holds dev-only checks.

## Review guidelines

Flag these as P1 (they break the board's sourcing rules or the page):
- A number taken from, or a source naming, an aggregator site: llm-stats, benchlm, modelcap, benchgecko, neosignal or localaimaster. This applies to prose as well as score tuples.
- A vendor-reported score (launch posts, model cards, a competitor's comparison table, context windows from provider docs, a blended price the board computes from list prices) not marked `ven`.
- A score that is estimated or guessed. A missing score must be omitted.
- A new benchmark id used without a `BENCH` entry and a `BENCH_ORDER` entry.
- An `EFFORT` first row that doesn't match the model's `aaii` and `costTask`, or names that don't match across `MODELS`, `EFFORT` and `PRICES`.
- A data change without a `CHANGELOG` entry, or `ASOF` not equal to the newest `CHANGELOG` date.
- A JavaScript error, a broken tab, or a change that drops `<!doctype html>`, the charset or viewport meta, the `<title>`, the light/dark theme tokens, the footer's source credits, or the copyright line `© 2026 millibus. All rights reserved.`
- Deleting `.nojekyll`, or adding a LICENSE file.

Flag these as P2:
- A touched column whose `BENCH.asof` wasn't bumped to the date of its newest data, or a model released after its column's `asof`.
- A model note, `BENCH` description, warning or caveat that quotes a number the data no longer has, or claims a figure the model has no tuple for.
- Wording that ages: ranks ("second on WebDev"), "today", "newest", "N days old", promo deadlines.
- A `ctx` value not marked `ven`.
- A new independent evaluator supplying scores without being added to the footer list and the README.

Don't flag:
- Numbers that differ from your own memory of a benchmark. The board records what its cited source published on the stated date; flag only if the PR's own source link contradicts the value.
- Minified or dense style in `index.html` that matches the surrounding code.

## Verifying

```
node scripts/check-data.mjs    # data consistency, no dependencies
node scripts/smoke.mjs         # headless Chromium: all five tabs, no errors, header matches data
```

Both must pass. `smoke.mjs` needs Playwright and a Chromium; set `CHROMIUM_PATH` if the browser isn't at `/opt/pw-browsers/chromium`. Never run `playwright install`.
