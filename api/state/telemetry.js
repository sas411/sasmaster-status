// Vercel serverless route: GET /api/state/telemetry
// WARROOM-READPLANE-001 Phase 4 — live per-tab state endpoint, TELEMETRY.
//
// Cadence per warroom/cadence-registry.json (Shiv's ruling, 2026-08-26): SSE,
// 30s cadence, stale at 60s.
//
// Live query path wired 2026-08-26: proxies through api.sasmaster.dev's new
// GET /api/warroom/state/telemetry route, which reads the S3 cache
// scripts/warroom-telemetry-ops-sync.js writes (Mac LaunchAgent, STAGED —
// not yet installed by Shiv; see LaunchAgents/com.sasmaster.warroom-telemetry-ops-sync.plist).
// Until that job is installed, the proxy call fails (no cache blob yet) and
// every field correctly renders ERROR — that is the honest C1 state for a
// query path that exists in code but has no live data behind it yet, not a
// bug in this file.
//
// Only `alerts_24h` has a real live source today (sasmaster.ops.alerts, via
// WARROOM-ALERT-001's table). slack_feed/avg_phase_time/active_traces/
// bug_fixes have no wired source in this pass — they render N/A honestly
// rather than fabricating a mapping that doesn't exist. A future card can
// add real sources for these without touching this file's structure.

const WarroomReadplane = require('../../lib/warroom-readplane');
const WarroomRender = require('../../lib/warroom-render');
const cadenceRegistry = require('../../warroom/cadence-registry.json');
const queryBudget = require('../../warroom/query-budget.json');

const TAB = 'TELEMETRY';
const TILE_IDS = ['alerts_24h', 'slack_feed', 'avg_phase_time', 'active_traces', 'bug_fixes'];

function mapTile(tileId, queryId, blob) {
  if (tileId === 'alerts_24h') {
    const cutoff = Date.now() - 24 * 3600 * 1000;
    const alerts = (blob.alerts || []).filter((a) => {
      const t = Date.parse(a.first_seen_utc || a.last_seen_utc || '');
      return !isNaN(t) && t >= cutoff;
    });
    // makeValue(value, source, computedAt) — real signature has no query_id
    // param (RENDER-001's own convention identifies via `source`, not
    // query_id — see warroom-v5.html's makeValue call sites); this contract
    // requires query_id (READPLANE payload shape), so attach it explicitly.
    const p = WarroomRender.makeValue(alerts.length, blob.source, blob.computed_at);
    p.query_id = queryId;
    return p;
  }
  // No wired source for these tiles this pass — honest N/A, not a fabricated mapping.
  const p = WarroomRender.makeNA('source not wired this pass', blob.source, blob.computed_at);
  p.query_id = queryId;
  return p;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const cadenceSeconds = cadenceRegistry.tabs[TAB].cadence_seconds;
  const cap = queryBudget.tabs[TAB].server_query_executions_per_day_cap;
  const budget = WarroomReadplane.checkAndIncrementBudget(TAB, cap);

  const nowIso = new Date().toISOString();
  let blob = null;
  let fetchError = null;
  if (budget.allowed) {
    try {
      blob = await WarroomReadplane.fetchTabBlob('telemetry');
    } catch (e) {
      fetchError = e && e.message ? e.message : 'unknown_fetch_error';
    }
  }

  const fields = {};
  TILE_IDS.forEach((tileId) => {
    const queryId = `${TAB.toLowerCase()}:${tileId}`;
    if (!budget.allowed) {
      fields[tileId] = WarroomReadplane.renderTile(
        { value: null, state: 'error', query_id: queryId + ':budget_breach', source: 'budget-cap' },
        cadenceSeconds
      );
      return;
    }
    if (fetchError) {
      fields[tileId] = WarroomReadplane.renderTile(
        WarroomRender.makeError(queryId, 'proxy-unreachable:' + fetchError),
        cadenceSeconds
      );
      return;
    }
    const payload = WarroomReadplane.mapBlobToTile(tileId, queryId, blob, (b) => mapTile(tileId, queryId, b));
    fields[tileId] = WarroomReadplane.renderTile(payload, cadenceSeconds);
  });

  res.status(200).json({
    fields: fields,
    computed_at: nowIso,
    source: fetchError ? ('ERROR — ' + fetchError) : (blob && blob.source) || 'unknown',
    budget: { allowed: budget.allowed, count: budget.count, cap: budget.cap }
  });
};
