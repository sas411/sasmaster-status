// Vercel serverless route: GET /api/state/telemetry
// WARROOM-READPLANE-001 Phase 4 — live per-tab state endpoint, TELEMETRY.
//
// Cadence per warroom/cadence-registry.json (Shiv's ruling, 2026-08-26): SSE,
// 30s cadence, stale at 60s.
//
// ⚠️ Every field below currently renders ERROR — motherduck-not-wired. This is
// NOT a placeholder value or a stub pretending to work — it is the correct,
// honest C1 behavior for a query source that does not exist yet in this
// runtime (see lib/warroom-readplane.js header for the real architecture gap
// and why `duckdb` wasn't added unilaterally). Swap `fetchTileData` for a real
// implementation once the query path is decided, and these fields start
// carrying real values with no other code change needed here.

const WarroomReadplane = require('../../lib/warroom-readplane');
const cadenceRegistry = require('../../warroom/cadence-registry.json');
const queryBudget = require('../../warroom/query-budget.json');

const TAB = 'TELEMETRY';
const TILE_IDS = ['alerts_24h', 'slack_feed', 'avg_phase_time', 'active_traces', 'bug_fixes'];

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
