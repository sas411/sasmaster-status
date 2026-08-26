// WARROOM-READPLANE-001 — shared read-plane helper: renderTile(), per-tab query
// budget enforcement, and the tile payload contract consumed by /api/state/<tab>
// and /api/stream/<tab>.
//
// C2/C4/C6: reuses WarroomRender's four-state payload contract (value/zero/na/
// error) rather than reimplementing it, and keeps `freshness` orthogonal to
// `state` per C4 — a stale field is state:"value" + freshness:"stale", never
// state:"stale" (that would collapse two contracts into one and reopen the C2
// fallthrough the whole WARROOM-OPS-V5 batch exists to close).
//
// ⚠️ REAL ARCHITECTURE GAP, not silently worked around (see DONE_LOG/report):
// this repo's Vercel serverless functions have no MotherDuck client wired in
// today (`npm ls duckdb` = empty; no motherduck HTTP proxy found in api/*.js).
// Adding the `duckdb` npm package pulls in a critical-severity, no-fix-available
// transitive vulnerability (node-gyp's build-time tar dependency, GHSA-34x7-...)
// into the production bundle — not something to add unilaterally. `fetchTileData`
// below is the swap point: until a real query path is wired (native client with
// the vuln accepted/mitigated, or a proxy through api.sasmaster.dev/command-api),
// every field correctly renders ERROR — <query_id>, per C1: an unwired source
// must render ERROR, never fabricate a value.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./warroom-clock'), require('./warroom-render'));
  } else {
    root.WarroomReadplane = factory(root.WarroomClock, root.WarroomRender);
  }
})(typeof self !== 'undefined' ? self : this, function (WarroomClock, WarroomRender) {
  'use strict';

  var FRESHNESS = { FRESH: 'fresh', LATE: 'late', STALE: 'stale' };

  // C4: freshness is a function of computed_at + declared cadence, orthogonal
  // to state. Late = past cadence, not yet past cadence×2. Stale = past cadence×2.
  function computeFreshness(computedAtIso, cadenceSeconds, now) {
    if (!computedAtIso || !cadenceSeconds) return FRESHNESS.FRESH; // nothing to compare against yet
    var computedAt = new Date(computedAtIso);
    var nowDate = now || WarroomClock.nowUtc();
    var ageSeconds = (nowDate.getTime() - computedAt.getTime()) / 1000;
    if (ageSeconds > cadenceSeconds * 2) return FRESHNESS.STALE;
    if (ageSeconds > cadenceSeconds) return FRESHNESS.LATE;
    return FRESHNESS.FRESH;
  }

  // Renders one tile: {value,state,freshness,source,query_id,computed_at}.
  // `payload` is a WarroomRender contract object (makeValue/makeZero/makeNA/makeError).
  // A future computed_at (server clock skew) always wins and forces state:error
  // per C5 — this must be checked before freshness, since a payload from the future
  // is not "fresh", it is broken.
  function renderTile(payload, cadenceSeconds, now) {
    WarroomRender.assertValidPayload(payload);
    var nowDate = now || WarroomClock.nowUtc();
    if (payload.computed_at) {
      var computedAt = new Date(payload.computed_at);
      if (computedAt.getTime() > nowDate.getTime()) {
        return {
          value: null, state: 'error', freshness: FRESHNESS.FRESH,
          query_id: payload.query_id || 'clock_skew', source: payload.source || null,
          computed_at: payload.computed_at, reason: 'clock skew'
        };
      }
    }
    var freshness = computeFreshness(payload.computed_at, cadenceSeconds, nowDate);
    var out = {
      value: payload.value !== undefined ? payload.value : null,
      state: payload.state,
      freshness: freshness,
      source: payload.source || null,
      query_id: payload.query_id || null,
      computed_at: payload.computed_at || null
    };
    if (payload.reason) out.reason = payload.reason;
    return out;
  }

  // ── query budget ──────────────────────────────────────────────────────────
  // In-memory counter, reset per cold start. NOTE (real limitation, not hidden):
  // Vercel serverless functions are NOT guaranteed to share memory across
  // invocations/instances — this counter is per-instance, not a true global cap.
  // A real hard cap needs a shared store (e.g. the run_log/alerts tables
  // themselves, queried for today's execution count) once the MotherDuck query
  // path is wired. This in-memory version is a best-effort placeholder for the
  // pre-query-path state this card ships in — documented, not silently assumed
  // to be correct.
  var _executionCounts = {};

  function checkAndIncrementBudget(tabId, dailyCap) {
    var today = new Date().toISOString().slice(0, 10);
    var key = tabId + ':' + today;
    _executionCounts[key] = (_executionCounts[key] || 0) + 1;
    return { allowed: _executionCounts[key] <= dailyCap, count: _executionCounts[key], cap: dailyCap };
  }

  function _resetBudgetForTest() { _executionCounts = {}; }

  // Swap point for the real MotherDuck query path once wired (see header note).
  // Until then, returns an ERROR payload for every requested tile — honest per
  // C1, never a fabricated value.
  function fetchTileData(tileId, queryId) {
    return WarroomRender.makeError(queryId || (tileId + ':not_wired'), 'motherduck-not-wired');
  }

  return {
    FRESHNESS: FRESHNESS,
    computeFreshness: computeFreshness,
    renderTile: renderTile,
    checkAndIncrementBudget: checkAndIncrementBudget,
    _resetBudgetForTest: _resetBudgetForTest,
    fetchTileData: fetchTileData
  };
});
