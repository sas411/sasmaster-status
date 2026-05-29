# TASK CARD: IDENTITY-NULL-NORMALIZE-001
## Normalize empty-string identifiers to NULL at ingestion (never touch real IDs)

**Date:** 2026-05-29
**Trigger:** fusion-QA agent (commit 2bb6c0e) found 33,348 IMDB-sourced rows with
`imdb_tconst = ''` (empty string) instead of NULL — G2 WARN / G5 FAIL, same rows.
**Sequence:** Slots into the BASELINE-REFRESH suite (runs at ingestion, before fusion reads).
**TASKS.md sync:** `!build TASKS-MD-SYNC IDENTITY-NULL-NORMALIZE-001`

---

## CONTEXT

An empty string is NOT an identifier — it is a corrupted way of recording "no identifier."
It is more dangerous than NULL because it passes `notna()` checks, false-matches other empty
strings on joins (`'' == ''` is true), and inflates coverage denominators. This card
normalizes `'' → NULL` across all ID columns at ingestion so absence is recorded honestly.

**This card does NOT change any real ID.** Real tconsts (tt…), EIDR DOIs, TMDB IDs, nconsts
remain byte-identical. Only the broken representation of *absence* (`''`) is fixed.
This is fully consistent with the durable-identity doctrine: identity is protected; a
corrupted encoding of "no identity" is cleaned so resolution can work.

---

## CONSTRAINTS

- **Touch ONLY empty-string values.** `WHEN col = '' THEN NULL` — every other value passes
  through untouched. No regex, no trimming of real IDs, no case changes.
- Apply at INGESTION (the BASELINE-REFRESH land step), before any fusion read — so the
  fusion engine never sees an empty-string ID.
- Apply to ALL identifier columns, not just imdb_tconst:
    imdb_id / imdb_tconst, imdb_epi_id, series_imdb_id, eidr_id,
    tmdb_id / tmdb_mov_ / tmdb_tv_, series_tmdb_id, opusID, nconst,
    GN_ID_ASSET, GN_PARENT_KEY, PROGRAM_ID, FYI_PARENT_ID, and every external_id
    (wikidata_id, tvdb_id, twitter_id, etc.)
- Also normalize whitespace-only strings (`'   ' → NULL`) — same failure mode.
- Do NOT delete the 33,348 rows. After normalization they are unmatched (NULL imdb_id,
  NULL eidr_id) → route to the Resolver agent. Some carry a real tconst in IMDB that the
  source export dropped; the Resolver will find and attach it.
- Dated-partition write only (non-destructive). Prior partitions preserved for diff.
- gitleaks clean before commit.

## TOKENS
```
APPLY AT: imdb/<dataset>/<date>/ land step (BASELINE-REFRESH ingestion)
          + a one-time backfill pass over current parent_keys/v2 + curated outputs
ROUTE:    normalized-to-NULL unanchored rows → fusion_ledger/resolver/ (unmatched queue)
```

## NORMALIZATION RULE (the only transformation)
```python
from pyspark.sql import functions as f

ID_COLS = ["imdb_id","imdb_tconst","imdb_epi_id","series_imdb_id","eidr_id",
           "tmdb_id","series_tmdb_id","opusID","nconst",
           "GN_ID_ASSET","GN_PARENT_KEY","PROGRAM_ID","FYI_PARENT_ID",
           "wikidata_id","tvdb_id","twitter_id","instagram_id","facebook_id"]

def null_blank(df):
    for c in [c for c in ID_COLS if c in df.columns]:
        df = df.withColumn(c, f.when(f.trim(f.col(c)) == "", None).otherwise(f.col(c)))
    return df
# Real IDs are untouched. Only '' and whitespace-only become NULL.
```

## PHASES
- Phase 1: Add `null_blank()` to the IMDB ingestion land step. Re-run G2/G5 on the delta.
- Phase 2: One-time backfill over current parent_keys/v2 + 6 curated outputs.
- Phase 3: Route the 33,348 (now NULL/NULL) rows to fusion_ledger/resolver/ as unmatched.
- Phase 4: Re-run fusion-QA agent. Confirm G2 WARN clears and G5 FAIL → PASS.

## BUILD ORDER: 1 → 2 → 3 → 4

## PRIORITY FLAGS
```
🔴 NEVER alter a non-empty ID value — only '' and whitespace-only → NULL
🔴 Do not delete unanchored rows — route to Resolver, never discard
🔴 Re-run QA agent after; G5 must flip FAIL → PASS, G10 spine byte-diff must stay PASS
🟡 Add whitespace-only normalization, not just exact empty string
🟢 Log count of normalized cells per column to #builds (visibility into source quality)
```

## DOCTRINE ADDITION (fold into data-fusion-mastery §2.1)
> Empty string is never a valid identifier. Normalize `'' → NULL` (and whitespace-only
> → NULL) on land, before any anchor check. `''` is more dangerous than NULL: it passes
> `notna()`, false-matches other blanks on joins, and inflates coverage. Normalizing
> absence is NOT changing identity — real IDs are always preserved byte-for-byte.

## QA GATES
🔴 Real-ID preservation: count of distinct non-empty IDs unchanged pre/post (the proof we touched nothing real)
🔴 G5 Null PK Guard flips FAIL → PASS; G10 Spine Byte-Diff stays PASS
🔴 33,348 rows present in resolver queue, zero deleted
