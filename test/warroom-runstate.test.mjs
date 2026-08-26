// WARROOM-RUNSTATE-001 — structural invariant + watchdog + bootstrap tests for run_state().
// Wired into `npm test` (node --test test/). No live CI gate exists yet (same gap
// WARROOM-TREND-001 flagged) — not invented here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const WarroomRunstate = require('../lib/warroom-runstate.js');

const NOW = new Date('2026-08-24T12:00:00Z');

test('never_run: no row at all', () => {
  const r = WarroomRunstate.run_state({ job: 'ghost-job', latestRow: null, now: NOW });
  assert.equal(r.state, 'never_run');
  assert.equal(r.reason, 'N/A — never run');
  assert.equal(r.run_id, null);
});

test('succeeded: terminal record, exit_code 0', () => {
  const r = WarroomRunstate.run_state({
    job: 'x', now: NOW,
    latestRow: { run_id: 'r1', started_at: '2026-08-24T11:00:00Z', finished_at: '2026-08-24T11:05:00Z', exit_code: 0 },
  });
  assert.equal(r.state, 'succeeded');
  assert.equal(r.run_id, 'r1');
  assert.equal(r.percent, null); // structural invariant: percent never rendered on a terminal record
});

test('failed: terminal record, exit_code != 0', () => {
  const r = WarroomRunstate.run_state({
    job: 'x', now: NOW,
    latestRow: { run_id: 'r2', started_at: '2026-08-24T11:00:00Z', finished_at: '2026-08-24T11:05:00Z', exit_code: 3 },
  });
  assert.equal(r.state, 'failed');
});

test('structural invariant: no combination of terminal record + running/stuck state is constructible', () => {
  // Sweep every state the machine can return for a terminal row and assert none of them
  // is 'running' or 'stuck' -- these states require finished_at to be absent by construction.
  const exitCodes = [0, 1, 137, -1];
  for (const ec of exitCodes) {
    const r = WarroomRunstate.run_state({
      job: 'sweep', now: NOW,
      latestRow: { run_id: 'rx', started_at: '2026-08-01T00:00:00Z', finished_at: '2026-08-01T00:05:00Z', exit_code: ec },
      percent: 55, // deliberately pass percent on a terminal row -- must be discarded
    });
    assert.notEqual(r.state, 'running', `terminal row with exit ${ec} must not be 'running'`);
    assert.notEqual(r.state, 'stuck', `terminal row with exit ${ec} must not be 'stuck'`);
    assert.equal(r.percent, null, 'percent must never render for a terminal record, even if passed');
  }
});

test('watchdog positive: age > 2x p95, no terminal record -> stuck', () => {
  // p95 of a 5-run history of ~10min jobs; seed a run started 45min ago (> 2x ~10min).
  const durationsMs = [9 * 60000, 10 * 60000, 10 * 60000, 11 * 60000, 12 * 60000]; // p95 ~= 12min
  const startedAt = new Date(NOW.getTime() - 45 * 60000).toISOString();
  const r = WarroomRunstate.run_state({
    job: 'tmdb-bulk-loader', now: NOW,
    latestRow: { run_id: 'stuck-run-1', started_at: startedAt, finished_at: null, exit_code: null },
    terminalDurationsMs: durationsMs,
  });
  assert.equal(r.state, 'stuck');
  assert.equal(r.run_id, 'stuck-run-1');
  assert.ok(r.reason.startsWith('STUCK'));
});

test('watchdog negative: age at 1.5x p95, no terminal record -> running, not stuck', () => {
  const durationsMs = [9 * 60000, 10 * 60000, 10 * 60000, 11 * 60000, 12 * 60000]; // p95 ~= 12min
  const p95 = WarroomRunstate.computeP95(durationsMs);
  const startedAt = new Date(NOW.getTime() - Math.round(p95 * 1.5)).toISOString();
  const r = WarroomRunstate.run_state({
    job: 'tmdb-bulk-loader', now: NOW,
    latestRow: { run_id: 'ok-run-1', started_at: startedAt, finished_at: null, exit_code: null },
    terminalDurationsMs: durationsMs,
    percent: 40,
  });
  assert.equal(r.state, 'running');
  assert.equal(r.percent, 40);
});

test('bootstrap: fewer than N terminal records -> N/A insufficient history, never a silent "running" fallback', () => {
  const r = WarroomRunstate.run_state({
    job: 'new-job', now: NOW,
    latestRow: { run_id: 'boot-1', started_at: new Date(NOW.getTime() - 999 * 3600000).toISOString(), finished_at: null, exit_code: null },
    terminalDurationsMs: [5 * 60000, 6 * 60000], // 2 < BOOTSTRAP_N (5)
  });
  assert.equal(r.state, 'na_insufficient_history');
  assert.equal(r.bootstrap_mode, 'iii_interim');
  assert.equal(r.reason, `N/A — insufficient history (2/${WarroomRunstate.BOOTSTRAP_N} runs)`);
  assert.notEqual(r.state, 'running', 'bootstrap gap must never silently render running');
});

test('bootstrap: zero terminal records -> same honest N/A, not running', () => {
  const r = WarroomRunstate.run_state({
    job: 'brand-new-job', now: NOW,
    latestRow: { run_id: 'boot-0', started_at: new Date(NOW.getTime() - 1000).toISOString(), finished_at: null, exit_code: null },
    terminalDurationsMs: [],
  });
  assert.equal(r.state, 'na_insufficient_history');
  assert.equal(r.p95, null);
});

test('C5 clock skew: started_at in the future renders ERROR, not running/succeeded', () => {
  const future = new Date(NOW.getTime() + 3600000).toISOString();
  const r = WarroomRunstate.run_state({
    job: 'x', now: NOW,
    latestRow: { run_id: 'future-run', started_at: future, finished_at: null, exit_code: null },
  });
  assert.equal(r.state, 'error');
  assert.equal(r.reason, 'ERROR — clock skew');
});

test('readError forces error state regardless of any row data', () => {
  const r = WarroomRunstate.run_state({
    job: 'x', now: NOW, readError: true, queryId: 'run_state:x',
    latestRow: { run_id: 'irrelevant', started_at: '2026-08-01T00:00:00Z', finished_at: null, exit_code: null },
  });
  assert.equal(r.state, 'error');
  assert.equal(r.reason, 'ERROR — run_state:x');
});

test('computeP95 on empty/null input returns null (bootstrap trigger)', () => {
  assert.equal(WarroomRunstate.computeP95([]), null);
  assert.equal(WarroomRunstate.computeP95(null), null);
});
