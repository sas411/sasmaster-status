// Vercel serverless route: GET /api/stream/ops (SSE)
// WARROOM-READPLANE-001 Phase 4 — SSE push for OPS, 30s cadence per
// warroom/cadence-registry.json.
//
// ⚠️ REAL CONSTRAINT, not silently assumed away: Vercel Node serverless
// functions have a max execution duration (account-tier dependent, commonly
// 10-60s on standard plans, longer on Pro/Enterprise with config). A true
// always-open SSE connection may exceed that and get cut by the platform,
// which is why the client-side degrade-to-polling behavior (card constraint,
// §3.1) is not optional — it is the primary path on this platform, not a
// rare fallback. This handler streams for up to STREAM_MAX_MS then ends the
// response cleanly (not an error) so the client's reconnect logic treats it
// as a normal SSE close, not a failure needing the polling fallback — but the
// polling fallback must still exist and must still be exercised by VERIFY,
// per the card's own SSE assertion (sever the connection, confirm polling
// picks up AND the age chip keeps incrementing, never freezes).

const WarroomReadplane = require('../../lib/warroom-readplane');
const cadenceRegistry = require('../../warroom/cadence-registry.json');
const queryBudget = require('../../warroom/query-budget.json');

const TAB = 'OPS';
const TILE_IDS = ['tmdb_bulk_loader_run_state', 'high_priority_queue_row', 'cron_dot_legend', 'agent_timeline_24h'];
const STREAM_MAX_MS = 55000; // stay under common Vercel Node function limits

function buildPayload() {
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
  return { fields: fields, computed_at: nowIso, source: 'motherduck-not-wired' };
}

module.exports = async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-store',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  const cadenceMs = cadenceRegistry.tabs[TAB].cadence_seconds * 1000;
  const send = () => { res.write(`data: ${JSON.stringify(buildPayload())}\n\n`); };

  send();
  const interval = setInterval(send, cadenceMs);
  const stopTimer = setTimeout(() => { clearInterval(interval); res.end(); }, STREAM_MAX_MS);

  req.on('close', () => { clearInterval(interval); clearTimeout(stopTimer); });
};
