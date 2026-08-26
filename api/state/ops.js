// Vercel serverless route: GET /api/state/ops
// WARROOM-READPLANE-001 Phase 4 — live per-tab state endpoint, OPS.
//
// Cadence per warroom/cadence-registry.json (Shiv's ruling, 2026-08-26): SSE,
// 30s cadence, stale at 60s.
//
// ⚠️ Every field below currently renders ERROR — motherduck-not-wired — see
// api/state-telemetry.js and lib/warroom-readplane.js for why, and the swap
// point once a real query path is decided. Not a fabricated value.

const WarroomReadplane = require('../../lib/warroom-readplane');
const cadenceRegistry = require('../../warroom/cadence-registry.json');
const queryBudget = require('../../warroom/query-budget.json');

const TAB = 'OPS';
// TMDB bulk loader is the named §2.7 example this whole card exists to fix —
// this tile MUST resolve to the same run_state()-backed value DATA/QUEUE
// render once wired, per RUNSTATE-001's shared query (C6).
const TILE_IDS = ['tmdb_bulk_loader_run_state', 'high_priority_queue_row', 'cron_dot_legend', 'agent_timeline_24h'];

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const cadenceSeconds = cadenceRegistry.tabs[TAB].cadence_seconds;
  const cap = queryBudget.tabs[TAB].server_query_executions_per_day_cap;
  const budget = WarroomReadplane.checkAndIncrementBudget(TAB, cap);

  const nowIso = new Date().toISOString();
  const fields = {};
  TILE_IDS.forEach((tileId) => {
    const payload = budget.allowed
      ? WarroomReadplane.fetchTileData(tileId, `${TAB.toLowerCase()}:${tileId}`)
      : { value: null, state: 'error', query_id: `${TAB.toLowerCase()}:${tileId}:budget_breach`, source: 'budget-cap' };
    fields[tileId] = WarroomReadplane.renderTile(payload, cadenceSeconds);
  });

  res.status(200).json({
    fields: fields,
    computed_at: nowIso,
    source: 'motherduck-not-wired',
    budget: { allowed: budget.allowed, count: budget.count, cap: budget.cap }
  });
};
