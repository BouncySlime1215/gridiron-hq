# Chunk 14/21 scoring notes

Grounded in N14-alternative-market-arbitrage.md, N15-route-proxies-from-pbp.md, N16-dynasty-aging-curves-modern.md (read in full).

## N14 bucket (Kalshi/Polymarket vs sportsbook arb) — overall bottom line from researcher:
S2 (UCLA, arXiv 2605.00864, read in full) is the load-bearing number: whole-NBA-month, single-market
arb = $210 total; combinatorial = $560 total, 76.9% liquidity-capped to ~15 shares. NFL should do
WORSE (1/8 game volume, thinner Polymarket depth per Gridiron's own code comments). This is the
strongest real evidence in the chunk and it says the entire betting-execution opportunity here is
retail-toy-sized. Governance-gate + fantasy-over-betting priority means the "new" capability
candidates in this bucket should mostly be deprioritized even though they are cheap and honest;
the "fix" candidates that gate correctness (devig, CLV unification, fill simulator, Kalshi haircut)
are cheap (hours-days) correctness/audit work independent of whether the betting features ever ship,
so they score higher on value_per_cost.

## N15 bucket (route/coverage from PBP) — overall bottom line:
C1/C2 are not research findings requiring judgment calls — the researcher DOWNLOADED AND PARSED the
actual nflverse CSVs this session and confirmed populated columns (2024: 22,408/45,919 rows with
man/zone label) that Gridiron's ingestion code already fetches and discards. This is evidence=5
territory (verified primary data, not a paper claim) at near-zero cost (hours, one function edit +
ALTER TABLE). This is the standout candidate of the whole chunk — cheap, verified, directly feeds
Gridiron's one area of documented model skill (props, +27% Brier on 2+ TD).
C3-C7 build on top of C1/C2 with decreasing evidence strength (C3/C4 moderate, C5/C6 explicitly
"weak" per researcher's own candidate list, C7 "weak" but well-motivated by the props
point-estimate defect).

## N16 (dynasty aging curve refit)
Two real methodological papers (BP GAM-spline MLB delta-method revisit; Schuckers/Lopez/Macdonald
2023 NHL truncated-imputation, published/preprint with real leave-career-out CV numbers) both
directly target the exact bias in Gridiron's file (only good players observed at old ages,
literal-linear-reading-of-prose curve). Neither is NFL-specific — evidence transferred across sport
by analogy, not replicated in-domain — and this candidate is gated on an unbuilt historical
player-season import (N16-5, out of this chunk), so treat as test-first even though the methodology
itself is solid. Aligns with Nick's fantasy-over-betting standing priority.

## Per-candidate scores -> see StructuredOutput call.
