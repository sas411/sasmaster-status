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
