# sasmaster-status — War Room Data Contract

## ONE-SOURCE-001: Field Authority Map

Each fact in `status.json` has exactly one authority source. The same fact shown in multiple
War Room locations (v3 index, v5, mobile) must read `d.field_name` identically — never
re-derive from raw data in a frontend file.

| Field | Authority Source | Compute Location | Notes |
|-------|-----------------|-----------------|-------|
| `health.score` | `computeHealthScore()` | `generate-status.js` | 35% agents + 30% canaries + 25% freshness + 10% cron |
| `health.grade` | `computeHealthScore()` | `generate-status.js` | green/amber/red; amber floor if any component = 0% |
| `health.components` | `computeHealthScore()` | `generate-status.js` | per-component scores |
| `follow_up_count` | `computeFollowUp()` | `generate-status.js` | agent ERRORs + unexpected canary fails + freshness breaches + blocked tasks |
| `follow_up_items` | `computeFollowUp()` | `generate-status.js` | array of item descriptions |
| `source_freshness` | `buildSourceFreshness()` | `generate-status.js` | single authority for ALL freshness displays |
| `cost_summary.mtd_cost_usd` | `cost-log.jsonl` sum (current month) | `generate-status.js` | MTD only — label it as such in UI |
| `cost_summary.total_cost_usd` | `cost-log.jsonl` sum (all-time) | `generate-status.js` | all-time — never display alongside MTD without label |
| `cost_summary.authority` | constant `'cost-log.jsonl'` | `generate-status.js` | traces cost fact to canonical log |
| `kpis.agents_running` | live agent process scan | `generate-status.js` | |
| `kpis.s3_gb` | S3 lake scan | `generate-status.js` | |
| `canary_state` | `canary-state.json` | `canary-runner.js` (external) | KNOWN_FAIL set: gracenote_onconnect, eidr_query_api |

## Frontend Contract

Surfaces (index.html, warroom-v5.html) consume these fields via `adapt()` or `updateHealthScore()`.
They **never** recompute a value that is available server-side. The pattern:

```js
// CORRECT — server-computed authority
const pct = d.health?.score ?? null;  // null = genuinely unknown, renders as "—"

// WRONG — frontend recomputation (TRUTHFUL-VITALS-001 antipattern)
// const pct = d.kpis.agents_running / d.kpis.agents_total * 100;  // DO NOT DO THIS
```

## Verification: Same Fact in Three Locations

As of 2026-06-12, the following fields appear in all three War Room surfaces and have been
verified to read from the same `status.json` path:

- `health.score` → `healthPct` in both `index.html` and `warroom-v5.html` ✓
- `follow_up_count` → Follow-up Items KPI in both surfaces ✓
- `cost_summary.mtd_cost_usd` → MTD cost KPI in both surfaces ✓
- `source_freshness` → freshness table in both surfaces ✓

## Deployment

```bash
node generate-status.js          # generates status.json, pushes to S3
git add -A && git commit -m "..."
git push origin main              # triggers Vercel deploy
```
