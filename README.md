# Frontier Board

Frontier Board — single-page LLM board built around subscriptions: what each monthly plan costs, which models it includes, and which model and effort level is worth running on it, next to the benchmarks themselves (AA Intelligence Index, effort levels, SWE-bench/Terminal-Bench/DeepSWE, Arena, ARC-AGI, HLE). A Pricing switch shows per-token API prices instead. Live: https://millibus.github.io/frontier-board/. Data lives in the BENCH, MODELS, EFFORT, PRICES, PLAN_FAMILIES, PLANS and CHANGELOG blocks in index.html; each score is [value, quality, optional source note] with quality ind/ven/unv.

## Checks

`node scripts/check-data.mjs` validates the data blocks (no dependencies). `node scripts/smoke.mjs` loads the page in headless Chromium and clicks every tab; it needs playwright or playwright-core installed. Both run in GitHub Actions on every pull request and push to `main` (`.github/workflows/checks.yml`). Neither script is part of the published site.

## Data sources

Benchmark results belong to the organisations that publish them: Artificial Analysis, Arena, ARC Prize, Vals AI, Scale AI, Snorkel AI, OpenRouter, METR, MathArena, Sierra (τ-bench), the OSWorld authors, Steel, and Håvard Tveit Ihle (WeirdML), plus model vendors' own comparison tables, which are marked vendor-run. Each benchmark's primary source is linked on the site's Sources & caveats tab; vendor-run rows come from the model maker's own announcement or from a competitor's comparison table. Subscription prices, plan contents and limits come from each vendor's own pricing and help pages (linked on the Sources & caveats tab) and count as vendor-reported. This project is not affiliated with any of them.

© 2026 millibus. All rights reserved.
