// Vercel serverless route: GET /api/state/ops
// WARROOM-READPLANE-001 Phase 4 — live per-tab state endpoint, OPS.
//
// Cadence per warroom/cadence-registry.json (Shiv's ruling, 2026-08-26): SSE,
// 30s cadence, stale at 60s.
//
// Live query path wired 2026-08-26: proxies through api.sasmaster.dev's new
// GET /api/warroom/state/ops route (see api/state/telemetry.js for the full
// architecture note — same proxy, same S3-cache doctrine, same LaunchAgent
// dependency, currently STAGED not installed).
//
// `tmdb_bulk_loader_run_state` is the named §2.7 example this whole card
// exists to fix (three tabs, three answers, on a job that finished 8 days
// ago) — it resolves to the SAME run_state()-backed value DATA/QUEUE render
// (RUNSTATE-001's shared query, C6), matched here by job id
// `load-tmdb-to-s3` per the documented judgment call in WARROOM-RUNSTATE-001's
// own report (no job is literally named "tmdb bulk loader" in the run-log;
// this is the closest semantic match from JOB_ID_NAMING.md).
// high_priority_queue_row/cron_dot_legend/agent_timeline_24h have no wired
// source in this pass — honest N/A, not a fabricated mapping.

const WarroomReadplane = require('../../lib/warroom-readplane');
const WarroomRender = require('../../lib/warroom-render');
const cadenceRegistry = require('../../warroom/cadence-registry.json');
const queryBudget = require('../../warroom/query-budget.json');
const WarroomBudgetAlert = require('../../lib/warroom-budget-alert');

const TAB = 'OPS';
const TILE_IDS = ['tmdb_bulk_loader_run_state', 'high_priority_queue_row', 'cron_dot_legend', 'agent_timeline_24h'];
const TMDB_JOB_ID = 'load-tmdb-to-s3';

function withQueryId(payload, queryId) {
  payload.query_id = queryId;
  return payload;
}

function mapTile(tileId, queryId, blob) {
  if (tileId === 'tmdb_bulk_loader_run_state') {
    const job = (blob.jobs || []).find((j) => j.job === TMDB_JOB_ID);
    if (!job) {
      return withQueryId(WarroomRender.makeNA('job ' + TMDB_JOB_ID + ' not found in run-log', blob.source, blob.computed_at), queryId);
    }
    if (job.state === 'error') {
      // makeError(queryId, source) — job.run_id is the real provenance here,
      // carried in `source` since makeError has no separate field for it.
      return WarroomRender.makeError(queryId, 'run_state:' + (job.reason || 'error') + (job.run_id ? ' run_id=' + job.run_id : ''));
    }
    if (job.state === 'never_run' || job.state === 'na_insufficient_history') {
      return withQueryId(WarroomRender.makeNA(job.reason || job.state, blob.source, blob.computed_at), queryId);
    }
    // makeValue(value, source, computedAt) — job.run_id (real provenance for
    // the §2.7 named example) travels in `source` alongside blob.source since
    // the contract has no separate run_id field; both are useful for debugging.
    return withQueryId(
      WarroomRender.makeValue(job.state, (blob.source || '') + ' run_id=' + job.run_id, blob.computed_at),
      queryId
    );
  }
  return withQueryId(WarroomRender.makeNA('source not wired this pass', blob.source, blob.computed_at), queryId);
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const cadenceSeconds = cadenceRegistry.tabs[TAB].cadence_seconds;
  const staleAtSeconds = cadenceRegistry.tabs[TAB].stale_at_seconds;
  const cap = queryBudget.tabs[TAB].server_query_executions_per_day_cap;
  const budget = WarroomReadplane.checkAndIncrementBudget(TAB, cap);

  const nowIso = new Date().toISOString();
  let blob = null;
  let fetchError = null;
  if (budget.allowed) {
    try {
      blob = await WarroomReadplane.fetchTabBlob('ops');
    } catch (e) {
      fetchError = e && e.message ? e.message : 'unknown_fetch_error';
    }
  }

  // MAINTAINER Gap A/B fix (2026-08-26): on budget breach, serve the cached
  // last-successful payload (state unchanged, freshness recomputed) instead
  // of a blanket state:'error', and emit a real budget_breach alert row —
  // both were previously missing (query-budget.json's own on_breach doc
  // claimed them; neither existed in code). Best-effort alert write: never
  // let it block or corrupt the tile response (see warroom-budget-alert.js
  // header for the disclosed Vercel-runtime limitation).
  if (!budget.allowed) {
    try {
      WarroomBudgetAlert.emitBudgetBreachAlert(TAB, {
        query_id: `${TAB.toLowerCase()}:budget_breach`,
        count: budget.count,
        cap: budget.cap
      });
    } catch (e) {
      console.warn('[WARN] warroom budget_breach alert write failed for', TAB, '-', e && e.message);
    }
    const breach = WarroomReadplane.renderBreachFields(TAB, TILE_IDS, cadenceSeconds, undefined, staleAtSeconds);
    res.status(200).json({
      fields: breach.fields,
      computed_at: nowIso,
      source: breach.source,
      budget: { allowed: budget.allowed, count: budget.count, cap: budget.cap, served_from_cache: breach.servedFromCache }
    });
    return;
  }

  const fields = {};
  TILE_IDS.forEach((tileId) => {
    const queryId = `${TAB.toLowerCase()}:${tileId}`;
    if (fetchError) {
      fields[tileId] = WarroomReadplane.renderTile(
        WarroomRender.makeError(queryId, 'proxy-unreachable:' + fetchError),
        cadenceSeconds,
        undefined,
        staleAtSeconds
      );
      return;
    }
    const payload = WarroomReadplane.mapBlobToTile(tileId, queryId, blob, (b) => mapTile(tileId, queryId, b));
    fields[tileId] = WarroomReadplane.renderTile(payload, cadenceSeconds, undefined, staleAtSeconds);
  });

  // Cache this successful render (only when the fetch genuinely succeeded)
  // so a future breach on this tab has real data to serve instead of ERROR.
  if (!fetchError) {
    WarroomReadplane.cacheSuccessfulPayload(TAB, fields, nowIso, (blob && blob.source) || 'unknown');
  }

  res.status(200).json({
    fields: fields,
    computed_at: nowIso,
    source: fetchError ? ('ERROR — ' + fetchError) : (blob && blob.source) || 'unknown',
    budget: { allowed: budget.allowed, count: budget.count, cap: budget.cap }
  });
};
