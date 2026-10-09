# Frontier Board

Frontier Board — single-page LLM benchmark aggregator (AA Intelligence Index, cost-vs-intelligence charts, effort levels, SWE-bench/Terminal-Bench/DeepSWE, Arena, ARC-AGI, HLE). Live: https://millibus.github.io/frontier-board/. Data lives in the BENCH, MODELS, EFFORT, PRICES and CHANGELOG blocks in index.html; each score is [value, quality, optional source note] with quality ind/ven/unv.

## Checks

`node scripts/check-data.mjs` validates the data blocks (no dependencies). `node scripts/smoke.mjs` loads the page in headless Chromium and clicks every tab; it needs playwright or playwright-core installed. Neither script is part of the published site.

## Data sources

Benchmark results belong to the organisations that publish them: Artificial Analysis, Arena, ARC Prize, Vals AI, Scale AI, Snorkel AI, OpenRouter, METR, MathArena, Sierra (τ-bench), Steel, and Håvard Tveit Ihle (WeirdML), plus model vendors' own comparison tables, which are marked vendor-run. Each benchmark's primary source is linked on the site's Sources & caveats tab; vendor-run rows come from that vendor's own launch announcement. This project is not affiliated with any of them.

© 2026 millibus. All rights reserved.
