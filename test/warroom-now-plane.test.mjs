// WARROOM-NOWPLANE-001 — now_plane() library layer tests.
// Covers the VERIFY assertions this build can exercise without the render
// wiring (Phase 5, not built this pass — see DONE_LOG.md for what's blocked
// and why). Every test below maps to a named card VERIFY bullet in its
// comment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const NowPlane = require('../lib/warroom-now-plane.js');
const WarroomRunstate = require('../lib/warroom-runstate.js');

const NOW = new Date('2026-08-24T08:06:00Z'); // 04:06 ET (EDT, UTC-4) — the card's own defect timestamp

// ---------------------------------------------------------------------
// Cardinal assertion: stream-dead cannot carry an active pulse (VERIFY:
// "Stream-dead beats rows — the cardinal assertion" / "not constructible").
// ---------------------------------------------------------------------

test('pulseActive derives strictly from alive', () => {
  assert.equal(NowPlane.pulseActive(true), true);
  assert.equal(NowPlane.pulseActive(false), false);
  assert.equal(NowPlane.pulseActive(undefined), false);
});

test('makeStreamFrame throws — {alive:false, pulse:true} is not constructible', () => {
  assert.throws(() => {
    NowPlane.makeStreamFrame({ alive: false, pulse: true, now: NOW });
  }, TypeError);
});

test('makeStreamFrame accepts a consistent pair and freezes the result', () => {
  const f = NowPlane.makeStreamFrame({ alive: true, pulse: true, now: NOW });
  assert.equal(f.pulse, true);
  assert.throws(() => { f.pulse = false; }, /read only|Cannot assign/i);
});

test('never-connected beat renders "no beat received", not 0s (C1 path 4)', () => {
  const tracker = NowPlane.createLivenessTracker({ heartbeatIntervalMs: 25000, missedBeatsThreshold: 3 });
  const frame = tracker.evaluate(NOW);
  assert.equal(frame.alive, false);
  assert.equal(frame.lastBeatAt, null);
  assert.equal(frame.beatAgeMs, null); // caller renders "N/A — no beat received" off this null, never "0s"
});

// ---------------------------------------------------------------------
// Beat arithmetic (VERIFY: "Beat arithmetic").
// ---------------------------------------------------------------------

test('beat arithmetic: alive at (N-1)*I+1s, dead at N*I+1s', () => {
  const I = 25000, N = 3;
  const tracker = NowPlane.createLivenessTracker({ heartbeatIntervalMs: I, missedBeatsThreshold: N });
  tracker.recordBeat(NOW);

  const justAlive = new Date(NOW.getTime() + (N - 1) * I + 1000);
  const aliveFrame = tracker.evaluate(justAlive);
  assert.equal(aliveFrame.alive, true);

  const justDead = new Date(NOW.getTime() + N * I + 1000);
  const deadFrame = tracker.evaluate(justDead);
  assert.equal(deadFrame.alive, false);
  assert.equal(deadFrame.pulse, false);
});

test('beats_missed reported matches injected elapsed / I', () => {
  const I = 25000, N = 5;
  const tracker = NowPlane.createLivenessTracker({ heartbeatIntervalMs: I, missedBeatsThreshold: N });
  tracker.recordBeat(NOW);
  const later = new Date(NOW.getTime() + 3 * I + 500);
  const frame = tracker.evaluate(later);
  assert.equal(frame.beatsMissed, 3);
});

test('createLivenessTracker refuses to default I or N (Gate 3 is Shiv-only)', () => {
  assert.throws(() => NowPlane.createLivenessTracker({}), TypeError);
  assert.throws(() => NowPlane.createLivenessTracker({ heartbeatIntervalMs: 25000 }), TypeError);
});

// ---------------------------------------------------------------------
// Chip state machine + legend completeness (VERIFY: "Chip legend
// completeness").
// ---------------------------------------------------------------------

test('legend enumerates all 9 tokens', () => {
  assert.equal(NowPlane.CHIP_LEGEND.length, 9);
  const legendStates = new Set(NowPlane.CHIP_LEGEND.map((e) => e.state));
  Object.values(NowPlane.CHIP_STATES).forEach((s) => assert.ok(legendStates.has(s), s + ' missing from legend'));
});

test('grey renders only for retired', () => {
  const retired = NowPlane.computeChipState({ job_id: 'x', retired: true });
  assert.equal(retired.colorToken, 'grey');
  assert.equal(retired.state, 'retired');
  const notRetired = NowPlane.computeChipState({
    job_id: 'y', retired: false,
    runState: WarroomRunstate.run_state({ job: 'y', latestRow: null, now: NOW })
  });
  assert.notEqual(notRetired.colorToken, 'grey');
});

test('chip query failure renders ERROR, not green/grey, and carries the real query id', () => {
  const c = NowPlane.computeChipState({ job_id: 'z', readError: true, queryId: 'q-42' });
  assert.equal(c.reason, 'ERROR — q-42');
  assert.notEqual(c.colorToken, 'green');
  assert.notEqual(c.colorToken, 'grey');
});

test('a job with no run record renders never_run, not a fabricated state', () => {
  const rs = WarroomRunstate.run_state({ job: 'never-run-job', latestRow: null, now: NOW });
  const c = NowPlane.computeChipState({ job_id: 'never-run-job', runState: rs });
  assert.equal(c.state, 'never_run');
  assert.equal(c.reason, 'N/A — never run');
});

test('running/stuck chip tokens come from run_state(), never re-derived (C6)', () => {
  const stuckRow = { run_id: 'r1', started_at: new Date(NOW.getTime() - 999999999).toISOString(), finished_at: null };
  const rs = WarroomRunstate.run_state({ job: 'j', latestRow: stuckRow, terminalDurationsMs: [1000, 1000, 1000, 1000, 1000], now: NOW });
  assert.equal(rs.state, 'stuck');
  const chip = NowPlane.computeChipState({ job_id: 'j', runState: rs });
  assert.equal(chip.state, 'stuck');
  assert.equal(chip.colorToken, 'amber');
});

// ---------------------------------------------------------------------
// RUNNING · 100% unconstructible (VERIFY).
// ---------------------------------------------------------------------

test('a terminal record never carries a percent value', () => {
  const terminalRow = { run_id: 'r2', started_at: NOW.toISOString(), finished_at: NOW.toISOString(), exit_code: 0 };
  const rs = WarroomRunstate.run_state({ job: 'j2', latestRow: terminalRow, percent: 87, now: NOW });
  assert.equal(rs.percent, null); // run_state() itself enforces this — asserted here as this module's contract, not re-implemented
});

// ---------------------------------------------------------------------
// next_fire (VERIFY: "Next-fire is computed from the registry, not stored").
// ---------------------------------------------------------------------

const FIXTURE_MANIFEST = {
  version: 'test-fixture-1.0.0',
  generated_at: '2026-08-24T00:00:00Z',
  agents: [
    { name: 'fixture-job', schedule: '0 5 * * *', owner_script: 'x.js' }, // 05:00 ET daily
    { name: 'unparseable-job', schedule: 'StartInterval=300', owner_script: 'y.js' }
  ]
};

test('next_fire renders exactly the seeded fixture time and duration', () => {
  const reg = NowPlane.loadRegistryFromManifest(FIXTURE_MANIFEST);
  const nf = NowPlane.computeNextFire('fixture-job', reg, NOW); // NOW = 04:06 ET
  assert.equal(nf.in, '54m');
  assert.match(nf.at, /05:00 AM ET/);
});

test('changing only the fixture schedule to 04:30 changes next_fire.in to 24m', () => {
  const manifest2 = JSON.parse(JSON.stringify(FIXTURE_MANIFEST));
  manifest2.agents[0].schedule = '30 4 * * *';
  const reg = NowPlane.loadRegistryFromManifest(manifest2);
  const nf = NowPlane.computeNextFire('fixture-job', reg, NOW);
  assert.equal(nf.in, '24m');
});

test('unparseable schedule renders exactly "N/A — no schedule in registry"', () => {
  const reg = NowPlane.loadRegistryFromManifest(FIXTURE_MANIFEST);
  const nf = NowPlane.computeNextFire('unparseable-job', reg, NOW);
  assert.deepEqual(nf, { state: 'N/A — no schedule in registry' });
});

test('an unknown job_id renders exactly "N/A — no schedule in registry"', () => {
  const reg = NowPlane.loadRegistryFromManifest(FIXTURE_MANIFEST);
  const nf = NowPlane.computeNextFire('does-not-exist', reg, NOW);
  assert.deepEqual(nf, { state: 'N/A — no schedule in registry' });
});

// ---------------------------------------------------------------------
// Idle is rendered, not empty; stale is not idle (VERIFY: "Idle is rendered,
// not empty" / "Stale run-log is not idle").
// ---------------------------------------------------------------------

test('zero open rows + fresh run-log => idle:true with a computed next_fire', () => {
  const reg = NowPlane.loadRegistryFromManifest(FIXTURE_MANIFEST);
  const plane = NowPlane.now_plane({
    openRunStates: [], registry: reg, now: NOW,
    runLogCadenceMs: 300000, lastRunLogWriteIso: new Date(NOW.getTime() - 60000).toISOString(),
    queryId: 'test-query-1'
  });
  assert.equal(plane.idle, true);
  assert.equal(plane.stale, null);
  assert.ok(plane.next_fire.at || plane.next_fire.state);
});

test('zero open rows + STALE run-log => idle:false, never IDLE', () => {
  const reg = NowPlane.loadRegistryFromManifest(FIXTURE_MANIFEST);
  const plane = NowPlane.now_plane({
    openRunStates: [], registry: reg, now: NOW,
    runLogCadenceMs: 300000, lastRunLogWriteIso: new Date(NOW.getTime() - 3600000).toISOString(), // 1h old vs 2*5min=10min cadence
    queryId: 'test-query-2'
  });
  assert.equal(plane.idle, false);
  assert.match(plane.stale.state, /^STALE /);
});

test('freshness cadence unavailable (FRESHNESS-001 blocked) => neither idle nor a confident stale claim', () => {
  const reg = NowPlane.loadRegistryFromManifest(FIXTURE_MANIFEST);
  const plane = NowPlane.now_plane({
    openRunStates: [], registry: reg, now: NOW,
    runLogCadenceMs: null, lastRunLogWriteIso: null,
    queryId: 'test-query-3'
  });
  assert.equal(plane.idle, false);
  assert.equal(plane.freshness.source, 'BLOCKED — evaluateFreshness() not built');
  assert.match(plane.stale.state, /freshness unknown/);
});

test('open rows present => idle:false regardless of freshness', () => {
  const reg = NowPlane.loadRegistryFromManifest(FIXTURE_MANIFEST);
  const plane = NowPlane.now_plane({
    openRunStates: [{ job_id: 'fixture-job', state: 'running' }],
    registry: reg, now: NOW, runLogCadenceMs: 300000,
    lastRunLogWriteIso: NOW.toISOString(), queryId: 'test-query-4'
  });
  assert.equal(plane.idle, false);
  assert.equal(plane.stale, null);
});

// ---------------------------------------------------------------------
// Registry-driven, mechanically (VERIFY: "Registry-driven, mechanically").
// ---------------------------------------------------------------------

test('unregistered_job: a run_log job absent from the registry is flagged, never silently green', () => {
  const reg = NowPlane.loadRegistryFromManifest(FIXTURE_MANIFEST);
  const flagged = NowPlane.findUnregisteredJobs(['fixture-job', 'ghost-job'], reg);
  assert.deepEqual(flagged, ['ghost-job']);
});

// ---------------------------------------------------------------------
// C5 — no ambient clock reads in this module.
// ---------------------------------------------------------------------

test('module source contains no ambient Date.now()/no-arg new Date() clock reads (C5) — coercing an injected value, e.g. new Date(now), is the same pattern lib/warroom-clock.js itself uses and is not an ambient read', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../lib/warroom-now-plane.js', import.meta.url), 'utf8');
  const matches = src.match(/Date\.now\(\)|new Date\(\s*\)/g) || [];
  assert.equal(matches.length, 0, 'found ambient clock reads: ' + JSON.stringify(matches));
});
