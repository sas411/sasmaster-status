# VERIFY-THEN-RESOLVE — 2026-05-29
## Two read-only checks, a hard gate, then the coverage-lift run

Paste these into Claude Code in order. The GATE between them is non-negotiable:
RESOLVER-001 does NOT run unless both checks pass.

---

## STEP 1 — VERIFY-NULL-NORMALIZE (read-only, no writes)

```
TASK: VERIFY-NULL-NORMALIZE — confirm IDENTITY-NULL-NORMALIZE-001 EXECUTED (not just committed)

CONTEXT:
The card shipped (War Room + Obsidian + S3 all show artifacts) but the last QA run still
showed G2 WARN: 33,348 rows with imdb_tconst=''. Committed ≠ executed. Confirm the
transform actually ran against the data before the Resolver consumes it.

CHECKS (read-only):
1. Count rows where imdb_tconst = '' OR trim(imdb_tconst) = '' across imdb/ + parent_keys/v2
   + curated outputs. Expected after normalize: 0.
2. Count distinct NON-EMPTY imdb_id pre/post normalize — MUST be unchanged (proves real
   IDs untouched).
3. Re-run fusion-qa-agent. Read G2 and G5.

PASS CRITERIA:
- G2 Dedup Gate: empty-string count = 0 (WARN clears)
- G5 Null PK Guard: the 33,348 non-tmdb_only unanchored rows GONE; only the expected
  ~272,064 tmdb_only-awaiting-match remain (that's a healthy Resolver queue, not a fail)
- G10 Spine Byte-Diff: still 861,878, Δ0.00%
- distinct non-empty imdb_id count unchanged pre/post

IF G2 STILL SHOWS EMPTY STRINGS:
→ the normalize did not execute. Run null_blank() against imdb/ ingestion + backfill
  parent_keys/v2 + curated, re-run QA, THEN proceed. Do not skip to Resolver on dirty input.

OUTPUT: post results to #sasmaster-builds. No writes to spine in this step.
```

---

## STEP 2 — VERIFY-LEDGER-LIVE (read-only, no writes)

```
TASK: VERIFY-LEDGER-LIVE — confirm FUSION-LEDGER-001 is live before any Resolver write

CONTEXT:
Per the fusion doctrine + the card itself, NO agent write touches S3 without a ledger
entry that makes it reversible. The Resolver is a write-heavy agent (170-220K new
bindings). The ledger must be confirmed live first — this is the safety net.

CHECKS (read-only):
1. fusion_ledger/ schema exists on S3 (resolver/ promotion/ conflict/ blindspot/ _audit/).
2. write_ledger() module present and importable in build_curated_*.py + Resolver path.
3. cert_gate='BYPASS' test: confirm a BYPASS attempt HARD-FAILS the agent (the gate works).
4. Confirm every write path has a matching reverse (Unlink) operation defined.

PASS CRITERIA:
- ledger schema live, write_ledger() wired, cert_gate=BYPASS hard-fails, reverse op exists

IF NOT LIVE:
→ FUSION-LEDGER-001 must finish landing before Resolver runs. Hold.

OUTPUT: post results to #sasmaster-builds. No writes in this step.
```

---

## ===== HARD GATE =====
## RESOLVER-001 runs ONLY IF:
##   STEP 1 PASS (G2 clear, G5 drops 33,348, spine unchanged, real IDs intact)
##   AND STEP 2 PASS (ledger live, cert_gate hard-fails, reverse op exists)
## If either fails — STOP, fix, re-verify. Do not write to the spine on unverified ground.
## =======================

---

## STEP 3 — RESOLVER-001 PHASE 1 (the coverage lift — WRITES, gated)

```
TASK: RESOLVER-001 PHASE 1 — deterministic tconst binding (the 68% → ~88% lift)

GATE: DEPENDS ON VERIFY-NULL-NORMALIZE [x] AND VERIFY-LEDGER-LIVE [x]
      Do not start unless both are marked done and passed.

CONTEXT:
Phase 1 is a deterministic join, NOT fuzzy matching: spine.tmdb_id → curated_movies.imdb_id.
All 556,449 curated movies already have imdb_id populated. This join simply hasn't been
executed yet. Expected lift: 170K-220K new tconst bindings. No guesses, no fuzzy logic —
just a join that resolves cleanly. (Phases 2-4 = null-fix residual + fuzzy ≥0.92 + OPUS
adjudication, run separately AFTER P1 verifies.)

CONSTRAINTS (data-fusion-mastery doctrine):
- Every binding written to fusion_ledger/resolver/ FIRST, then spine — reversible.
- Deterministic join only this phase (confidence ~1.0, auto-tier). No fuzzy in P1.
- Type match enforced (movie vs TV) — hard reject on mismatch.
- imdb_id stays tt-prefixed; never overwrite an existing real binding (additive only).
- Spine columns byte-identical except the newly-bound imdb_id where it was NULL.
- The 33,348 NULL-normalized rows are eligible inputs here (this is where they get resolved).

PHASES:
P1.1: deterministic join spine.tmdb_id ↔ curated_movies.imdb_id, confidence ~1.0
P1.2: write bindings to fusion_ledger/resolver/ (proposed → auto-promote at conf≥0.95)
P1.3: apply promoted bindings to spine (NULL imdb_id → resolved tt-id only; never overwrite)
P1.4: re-run fusion-qa-agent. Verify:
       - tconst coverage rises 68.4% → target ≥88%
       - G10 spine byte-diff: row count stable (bindings fill NULLs, don't add rows)
       - G5 tmdb_only-awaiting-match count DROPS by the bound amount
       - every binding has a ledger entry (reversibility check)
P1.5: publish coverage KPI to War Room (tconst_coverage_pct, resolver_p1_bindings)

QA GATES:
🔴 Every binding logged to ledger before spine write (reversibility)
🔴 No existing real imdb_id overwritten — additive only (fill NULLs)
🔴 Type match enforced; spine row count stable (G10)
🟡 Coverage KPI published to War Room so the matrix starts populating

OUTPUT: post P1 result + new coverage % to #sasmaster-builds.
```

---

## ANSWER TO "WHEN DO COUNTS + MATCH RATES PUBLISH"
- Clean match rate (G2/G5): after STEP 1 re-run — minutes.
- tconst coverage 68%→~88%: after STEP 3 / RESOLVER-001 P1 completes.
- Full Movie/TV/Episode/People × match% matrix in War Room: after CURATED ×4 runs with
  the coverage-KPI step (those write the per-type KPIs). That is the publish moment for
  the full matrix — not before. Fresh IMDB/TMDB raw counts need BASELINE-REFRESH-001.
```
