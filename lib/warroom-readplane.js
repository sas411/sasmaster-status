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

  // ── last-successful-payload cache (MAINTAINER Gap B fix, 2026-08-26) ───────
  // In-memory, per-instance/cold-start-scoped, same limitation class as the
  // budget counter above (Vercel serverless instances do not share memory).
  // Stores the last successfully-rendered `fields` per tab so a budget breach
  // can serve it instead of a blanket state:'error' (the bug MAINTAINER
  // found: api/state/{ops,telemetry}.js rendered ERROR unconditionally on
  // breach, with no cache anywhere — contradicting the card's explicit "on
  // breach it serves the last successful payload unchanged in state"
  // requirement).
  var _lastSuccessfulPayload = {};

  function cacheSuccessfulPayload(tab, fields, computedAt, source) {
    _lastSuccessfulPayload[tab] = { fields: fields, computed_at: computedAt, source: source };
  }

  function getCachedPayload(tab) {
    return _lastSuccessfulPayload[tab] || null;
  }

  function _resetPayloadCacheForTest() { _lastSuccessfulPayload = {}; }

  // C4 says a stale/breached response must never look "fresh" — a live query
  // was just refused, so telling the viewer "fresh" is misleading regardless
  // of the cached data's true age. Compute freshness normally, then floor it
  // at LATE (never FRESH) for a breach-served field.
  function computeBreachFreshness(computedAtIso, cadenceSeconds, now) {
    var f = computeFreshness(computedAtIso, cadenceSeconds, now);
    return f === FRESHNESS.FRESH ? FRESHNESS.LATE : f;
  }

  // On budget breach: for each tile, serve the cached field with `state`
  // UNCHANGED and `freshness` recomputed live from that field's true
  // `computed_at` (never re-stamped fresh). If nothing has ever been cached
  // for this tab yet (cold start, no prior success), there is nothing honest
  // to serve — falls back to state:'error' for that tile only, same as
  // before, never a fabricated value (C1).
  function renderBreachFields(tab, tileIds, cadenceSeconds, now) {
    var cached = getCachedPayload(tab);
    var nowDate = now || WarroomClock.nowUtc();
    var fields = {};
    tileIds.forEach(function (tileId) {
      var queryId = tab.toLowerCase() + ':' + tileId;
      var cachedField = cached && cached.fields && cached.fields[tileId];
      if (cachedField) {
        var out = {
          value: cachedField.value !== undefined ? cachedField.value : null,
          state: cachedField.state, // UNCHANGED per card requirement
          freshness: computeBreachFreshness(cachedField.computed_at, cadenceSeconds, nowDate),
          source: cachedField.source || null,
          query_id: cachedField.query_id || queryId,
          computed_at: cachedField.computed_at || null
        };
        if (cachedField.reason) out.reason = cachedField.reason;
        fields[tileId] = out;
      } else {
        fields[tileId] = renderTile(
          { value: null, state: 'error', query_id: queryId + ':budget_breach_no_cache', source: 'budget-cap' },
          cadenceSeconds,
          nowDate
        );
      }
    });
    return {
      fields: fields,
      source: cached ? (cached.source || 'unknown') + ' (cached, budget-breached)' : 'budget-cap-no-cache',
      servedFromCache: !!cached
    };
  }

  // Swap point for the real MotherDuck query path once wired (see header note).
  // Until then, returns an ERROR payload for every requested tile — honest per
  // C1, never a fabricated value.
  function fetchTileData(tileId, queryId) {
    return WarroomRender.makeError(queryId || (tileId + ':not_wired'), 'motherduck-not-wired');
  }

  // ── live query path — WARROOM-READPLANE-001, wired 2026-08-26 ──────────────
  // Doctrine (command-api/src/railway.ts): Railway never queries MotherDuck
  // directly. scripts/warroom-telemetry-ops-sync.js (Mac LaunchAgent, staged not
  // yet installed by Shiv) pushes S3 blobs; command-api's new
  // GET /api/warroom/state/<tab> routes read them via the existing readS3JSON()
  // convention and this function fetches THAT — one HTTP call per request, not
  // one per tile, since the whole tab's data comes back in a single payload.
  var WARROOM_STATE_BASE = 'https://api.sasmaster.dev/api/warroom/state/';

  function fetchTabBlob(tab) {
    // Node (api/state/*.js, Vercel serverless) has global fetch since Node 18;
    // browser path (warroom-v5.html) has it natively. No new dependency either
    // side — same reasoning as avoiding the duckdb package above.
    return fetch(WARROOM_STATE_BASE + tab, { headers: { Accept: 'application/json' } })
      .then(function (resp) {
        if (!resp.ok) {
          throw new Error('proxy_http_' + resp.status);
        }
        return resp.json();
      });
  }

  // Maps one tile out of a fetched tab blob. `blob` is what fetchTabBlob(tab)
  // resolved to (command-api's response shape: {..., computed_at, source,
  // freshness, alerts:[...] | jobs:[...] , error?}). `mapper(blob)` is a
  // per-tile-id function the caller supplies (tile shape varies by tab/tile —
  // this module doesn't know the domain semantics, the caller does).
  // Proxy-unreachable / blob-carries-error is handled honestly here in ONE
  // place (C1): every tile from a failed fetch renders ERROR, never a
  // fabricated fallback, and the actual failure reason is preserved in the
  // query_id so it's debuggable from the rendered page, not just logs.
  function mapBlobToTile(tileId, queryId, blob, mapper) {
    if (blob && blob.error) {
      return WarroomRender.makeError(queryId, 'warroom-proxy:' + blob.error);
    }
    try {
      var mapped = mapper(blob);
      if (mapped === undefined || mapped === null) {
        var na = WarroomRender.makeNA('no data for tile', blob && blob.source, blob && blob.computed_at);
        na.query_id = queryId;
        return na;
      }
      return mapped;
    } catch (e) {
      return WarroomRender.makeError(queryId, 'tile-mapper-threw:' + (e && e.message));
    }
  }

  return {
    FRESHNESS: FRESHNESS,
    computeFreshness: computeFreshness,
    renderTile: renderTile,
    checkAndIncrementBudget: checkAndIncrementBudget,
    _resetBudgetForTest: _resetBudgetForTest,
    cacheSuccessfulPayload: cacheSuccessfulPayload,
    getCachedPayload: getCachedPayload,
    _resetPayloadCacheForTest: _resetPayloadCacheForTest,
    renderBreachFields: renderBreachFields,
    fetchTileData: fetchTileData,
    fetchTabBlob: fetchTabBlob,
    mapBlobToTile: mapBlobToTile
  };
});
