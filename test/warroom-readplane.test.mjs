import { test } from 'node:test';
import assert from 'node:assert/strict';
import WarroomReadplane from '../lib/warroom-readplane.js';
import WarroomRender from '../lib/warroom-render.js';

test('renderTile: fresh value payload', () => {
  const now = new Date('2026-08-26T12:00:00Z');
  const payload = WarroomRender.makeValue(42, 'test-query', '2026-08-26T11:59:30Z');
  const out = WarroomReadplane.renderTile(payload, 120, now);
  assert.equal(out.state, 'value');
  assert.equal(out.freshness, 'fresh');
  assert.equal(out.value, 42);
});

test('renderTile: freshness NEVER a state value (C4)', () => {
  const now = new Date('2026-08-26T12:10:00Z'); // 10min after computed_at, cadence=120s -> stale
  const payload = WarroomRender.makeValue(42, 'test-query', '2026-08-26T12:00:00Z');
  const out = WarroomReadplane.renderTile(payload, 120, now);
  assert.equal(out.state, 'value'); // state stays value
  assert.equal(out.freshness, 'stale'); // staleness is freshness, not state
  assert.notEqual(out.state, 'stale');
});

test('renderTile: late band between cadence and cadence*2', () => {
  const now = new Date('2026-08-26T12:03:00Z'); // 180s after, cadence=120 -> late (120<180<=240)
  const payload = WarroomRender.makeValue(1, 'q', '2026-08-26T12:00:00Z');
  const out = WarroomReadplane.renderTile(payload, 120, now);
  assert.equal(out.freshness, 'late');
});

test('renderTile: future computed_at forces ERROR — clock skew (C5), never freshness:fresh', () => {
  const now = new Date('2026-08-26T12:00:00Z');
  const payload = WarroomRender.makeValue(1, 'q', '2026-08-26T13:00:00Z'); // 1h in the future
  const out = WarroomReadplane.renderTile(payload, 120, now);
  assert.equal(out.state, 'error');
  assert.equal(out.reason, 'clock skew');
});

test('renderTile: na/error payloads pass through with reason/query_id intact', () => {
  const naPayload = WarroomRender.makeNA('metric not wired', 'src', '2026-08-26T12:00:00Z');
  const out = WarroomReadplane.renderTile(naPayload, 120, new Date('2026-08-26T12:00:10Z'));
  assert.equal(out.state, 'na');
  assert.equal(out.reason, 'metric not wired');

  const errPayload = WarroomRender.makeError('q123', 'src');
  const outErr = WarroomReadplane.renderTile(errPayload, 120, new Date());
  assert.equal(outErr.state, 'error');
  assert.equal(outErr.query_id, 'q123');
});

test('checkAndIncrementBudget: allows up to cap, breaches after', () => {
  WarroomReadplane._resetBudgetForTest();
  for (let i = 0; i < 3; i++) {
    const r = WarroomReadplane.checkAndIncrementBudget('TESTTAB', 3);
    assert.equal(r.allowed, true);
  }
  const breach = WarroomReadplane.checkAndIncrementBudget('TESTTAB', 3);
  assert.equal(breach.allowed, false);
  assert.equal(breach.count, 4);
});

test('fetchTileData: unwired source renders ERROR, never a fabricated value (C1)', () => {
  const payload = WarroomReadplane.fetchTileData('some_tile', 'some:query');
  assert.equal(payload.state, 'error');
  assert.equal(payload.query_id, 'some:query');
  assert.equal(payload.value, null);
});

// MAINTAINER Gap B fix (2026-08-26) — breach-serves-last-payload was
// previously uncovered by this suite (flagged in DONE_LOG as an overstated
// commit claim). These tests exercise the actual cache+breach path.

test('renderBreachFields: no cache yet (cold start) -> honest ERROR, never fabricated', () => {
  WarroomReadplane._resetPayloadCacheForTest();
  const out = WarroomReadplane.renderBreachFields('COLDTAB', ['tile_a'], 30, new Date('2026-08-26T12:00:00Z'));
  assert.equal(out.servedFromCache, false);
  assert.equal(out.fields.tile_a.state, 'error');
  // Gap D regression (WARROOM-READPLANE-001, fixed 2026-08-27): a cold-start
  // miss never obtained a reading — state:'error' + freshness:'fresh' was the
  // contradictory pair a prior audit found here. Must never be fresh.
  assert.notEqual(out.fields.tile_a.freshness, 'fresh');
  assert.equal(out.fields.tile_a.freshness, 'stale');
});

test('renderTile: Gap E regression -- honors registry stale_at_seconds over cadence*2', () => {
  // cadence=30 would give cadence*2=60s stale threshold; registry rules 45s instead.
  const now = new Date('2026-08-26T12:00:50Z'); // 50s after computed_at
  const payload = WarroomRender.makeValue(1, 'q', '2026-08-26T12:00:00Z');
  const viaFallback = WarroomReadplane.renderTile(payload, 30, now); // no registry value -> cadence*2=60s -> not yet stale
  assert.equal(viaFallback.freshness, 'late');
  const viaRegistry = WarroomReadplane.renderTile(payload, 30, now, 45); // registry says stale at 45s
  assert.equal(viaRegistry.freshness, 'stale');
});

test('renderBreachFields: cached payload served with state UNCHANGED and freshness recomputed live, never fresh', () => {
  WarroomReadplane._resetPayloadCacheForTest();
  const cadenceSeconds = 30;
  const computedAt = '2026-08-26T12:00:00Z';
  const fields = {
    tile_a: { value: 7, state: 'value', freshness: 'fresh', source: 'motherduck:test', query_id: 'ops:tile_a', computed_at: computedAt }
  };
  WarroomReadplane.cacheSuccessfulPayload('OPS', fields, computedAt, 'motherduck:test');

  // 10s later: within cadence, would compute 'fresh' if not floored -- assert it is NOT fresh on breach.
  const soonAfter = new Date('2026-08-26T12:00:10Z');
  const soon = WarroomReadplane.renderBreachFields('OPS', ['tile_a'], cadenceSeconds, soonAfter);
  assert.equal(soon.servedFromCache, true);
  assert.equal(soon.fields.tile_a.state, 'value'); // UNCHANGED from cached state
  assert.notEqual(soon.fields.tile_a.freshness, 'fresh'); // never fresh on a breached response
  assert.equal(soon.fields.tile_a.freshness, 'late');
  assert.equal(soon.fields.tile_a.value, 7); // cached value preserved

  // 200s later: past stale_at (cadence*2=60s) -- must compute genuinely stale, not just floored-to-late.
  const muchLater = new Date('2026-08-26T12:03:20Z');
  const later = WarroomReadplane.renderBreachFields('OPS', ['tile_a'], cadenceSeconds, muchLater);
  assert.equal(later.fields.tile_a.state, 'value'); // state still unchanged from cache
  assert.equal(later.fields.tile_a.freshness, 'stale');
});

test('renderBreachFields: cached ERROR state stays ERROR (state unchanged means unchanged either way)', () => {
  WarroomReadplane._resetPayloadCacheForTest();
  const computedAt = '2026-08-26T12:00:00Z';
  const fields = {
    tile_b: { value: null, state: 'error', freshness: 'fresh', source: 'proxy', query_id: 'ops:tile_b', computed_at: computedAt, reason: 'proxy-unreachable' }
  };
  WarroomReadplane.cacheSuccessfulPayload('OPS', fields, computedAt, 'proxy');
  const out = WarroomReadplane.renderBreachFields('OPS', ['tile_b'], 30, new Date('2026-08-26T12:00:05Z'));
  assert.equal(out.fields.tile_b.state, 'error');
  assert.equal(out.fields.tile_b.reason, 'proxy-unreachable');
});
