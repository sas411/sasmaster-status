// WARROOM-OPSTIMELINE-001 — slot state machine + legend completeness tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const WarroomOpsTimeline = require('../lib/warroom-ops-timeline.js');
const WarroomOpsSchedule = require('../lib/warroom-ops-schedule.js');
const WarroomOpsJoin = require('../lib/warroom-ops-join.js');

const NOW = new Date('2026-08-27T18:00:00Z'); // 2:00 PM ET (EDT, UTC-4)

test('legend covers every state the module can emit (card VERIFY: legend completeness)', () => {
  const legendStates = new Set(WarroomOpsTimeline.LEGEND.map((e) => e.state));
  Object.values(WarroomOpsTimeline.STATES).forEach((s) => {
    assert.ok(legendStates.has(s), `state "${s}" has no legend entry`);
  });
});

test('grace_unset: elapsed slot, no matching run, grace_minutes is the literal "UNSET"', () => {
  const r = WarroomOpsTimeline.computeSlotState({
    job: 'sec-edgar', scheduledAtIso: '2026-08-27T10:00:00Z', now: NOW,
    hasCadence: true, graceMinutes: 'UNSET', matchedRun: null
  });
  assert.equal(r.state, 'grace_unset');
  assert.equal(r.reason, 'N/A — grace window unset');
});

test('missed: elapsed slot, no matching run, grace_minutes IS a real number and window has passed', () => {
  const r = WarroomOpsTimeline.computeSlotState({
    job: 'sec-edgar', scheduledAtIso: '2026-08-27T10:00:00Z', now: NOW,
    hasCadence: true, graceMinutes: 15, matchedRun: null
  });
  assert.equal(r.state, 'missed');
});

test('pending: elapsed slot, no matching run, grace_minutes real but window not yet passed', () => {
  const r = WarroomOpsTimeline.computeSlotState({
    job: 'sec-edgar', scheduledAtIso: '2026-08-27T17:55:00Z', now: NOW, // 5 min ago
    hasCadence: true, graceMinutes: 15, matchedRun: null
  });
  assert.equal(r.state, 'pending');
});

test('pending: slot in the future today', () => {
  const r = WarroomOpsTimeline.computeSlotState({
    job: 'sec-edgar', scheduledAtIso: '2026-08-27T20:00:00Z', now: NOW,
    hasCadence: true, graceMinutes: 'UNSET', matchedRun: null
  });
  assert.equal(r.state, 'pending');
});

test('ran_ok: matched terminal record, run_state succeeded', () => {
  const r = WarroomOpsTimeline.computeSlotState({
    job: 'media-intel', scheduledAtIso: '2026-08-27T10:00:00Z', now: NOW,
    hasCadence: true, graceMinutes: 'UNSET',
    matchedRun: { state: 'succeeded', run_id: 'r1', started_at: '2026-08-27T10:01:00Z', finished_at: '2026-08-27T10:05:00Z' }
  });
  assert.equal(r.state, 'ran_ok');
  assert.equal(r.run_id, 'r1');
});

test('ran_failed: matched terminal record, run_state failed', () => {
  const r = WarroomOpsTimeline.computeSlotState({
    job: 'tech-intel', scheduledAtIso: '2026-08-27T10:00:00Z', now: NOW,
    hasCadence: true, graceMinutes: 'UNSET',
    matchedRun: { state: 'failed', run_id: 'r2', started_at: '2026-08-27T10:01:00Z', finished_at: '2026-08-27T10:05:00Z' }
  });
  assert.equal(r.state, 'ran_failed');
});

test('running / stuck delegate to WarroomRunstate, never recompute p95 here', () => {
  const runningR = WarroomOpsTimeline.computeSlotState({
    job: 'x', scheduledAtIso: '2026-08-27T17:55:00Z', now: NOW,
    hasCadence: true, graceMinutes: 'UNSET',
    matchedRun: { state: 'running', run_id: 'r3', started_at: '2026-08-27T17:58:00Z', finished_at: null }
  });
  assert.equal(runningR.state, 'running');

  // 5 terminal durations of ~10min each -> p95 ~12min; started 45min ago -> stuck.
  const stuckR = WarroomOpsTimeline.computeSlotState({
    job: 'tmdb-bulk-loader', scheduledAtIso: '2026-08-27T17:00:00Z', now: NOW,
    hasCadence: true, graceMinutes: 'UNSET',
    matchedRun: { run_id: 'r4', started_at: '2026-08-27T17:15:00Z', finished_at: null },
    terminalDurationsMs: [9, 10, 10, 11, 12].map((m) => m * 60000)
  });
  assert.equal(stuckR.state, 'stuck');
});

test('unclassified: fleetClassified:false always wins, never "retired"', () => {
  const r = WarroomOpsTimeline.computeSlotState({
    job: 'JARVIS', scheduledAtIso: null, now: NOW,
    hasCadence: false, alwaysOn: true, fleetClassified: false, graceMinutes: 'UNSET', matchedRun: null
  });
  assert.equal(r.state, 'unclassified');
  assert.notEqual(r.state, 'retired');
});

test('not_scheduled: no cadence, not always-on', () => {
  const r = WarroomOpsTimeline.computeSlotState({
    job: 'ghost', scheduledAtIso: null, now: NOW,
    hasCadence: false, alwaysOn: false, fleetClassified: true, graceMinutes: 'UNSET', matchedRun: null
  });
  assert.equal(r.state, 'not_scheduled');
});

test('C5: a matched run whose started_at is in the future renders error, never a normal mark', () => {
  const r = WarroomOpsTimeline.computeSlotState({
    job: 'x', scheduledAtIso: '2026-08-27T17:00:00Z', now: NOW,
    hasCadence: true, graceMinutes: 'UNSET',
    matchedRun: { run_id: 'future', started_at: '2026-08-28T01:00:00Z', finished_at: null }
  });
  assert.equal(r.state, 'error');
  assert.equal(r.reason, 'ERROR — clock skew');
});

test('C5: invalid scheduled_at renders error, not a fabricated state', () => {
  const r = WarroomOpsTimeline.computeSlotState({
    job: 'x', scheduledAtIso: 'not-a-date', now: NOW, hasCadence: true, graceMinutes: 'UNSET', matchedRun: null
  });
  assert.equal(r.state, 'error');
});

// ---- schedule expansion ----

test('expandSlotsForWindow: daily cron produces exactly one slot for a 24h window', () => {
  const registry = {
    edgar: { job_id: 'edgar-scraper', grace_job_id: 'sec-edgar', display_name: 'SEC EDGAR', cron: '30 6 * * *', expected_cadence_seconds: 86400 }
  };
  const slots = WarroomOpsSchedule.expandSlotsForWindow(registry, 24, NOW);
  assert.equal(slots.length, 1);
  assert.equal(slots[0].job_id, 'edgar-scraper');
});

test('expandSlotsForWindow: axis is strictly monotonic (ascending scheduled_at)', () => {
  const registry = {
    a: { job_id: 'a', cron: '0 6 * * *', expected_cadence_seconds: 86400 },
    b: { job_id: 'b', cron: '0 2 * * *', expected_cadence_seconds: 86400 },
    c: { job_id: 'c', cron: '*/15 * * * *', expected_cadence_seconds: 900 }
  };
  const slots = WarroomOpsSchedule.expandSlotsForWindow(registry, 24, NOW).filter((s) => s.scheduled_at);
  for (let i = 1; i < slots.length; i++) {
    assert.ok(Date.parse(slots[i].scheduled_at) >= Date.parse(slots[i - 1].scheduled_at), 'slots must be non-decreasing');
  }
});

test('expandSlotsForWindow: no-cadence job (JARVIS) yields exactly one null-slot row, never fabricated times', () => {
  const registry = { j: { job_id: 'JARVIS', cron: null, always_on: true, fleet_classified: false } };
  const slots = WarroomOpsSchedule.expandSlotsForWindow(registry, 24, NOW);
  assert.equal(slots.length, 1);
  assert.equal(slots[0].scheduled_at, null);
  assert.equal(slots[0].fleetClassified, false);
});

// ---- shared join ----

test('buildOpsRows: unmatched slot survives the left join and renders grace_unset today', () => {
  const cronRegistry = { jobs: { edgar: { job_id: 'edgar-scraper', grace_job_id: 'sec-edgar', display_name: 'SEC EDGAR', cron: '30 6 * * *', expected_cadence_seconds: 86400 } } };
  const jobsRegistry = { jobs: { 'SEC EDGAR': { job_id: 'sec-edgar', grace_minutes: 'UNSET' } } };
  const rows = WarroomOpsJoin.buildOpsRows({ cronRegistry, jobsRegistry, runSummaryByJobId: {}, windowHours: 24, now: NOW });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, 'grace_unset');
  assert.equal(rows[0].run_id, null);
});

test('expandSlotsForWindow: bounds to today\'s ET calendar day, not an arbitrary trailing span (sub-hourly cron does not explode past 24h)', () => {
  const registry = { pj: { job_id: 'process-jobs', cron: '* * * * *', expected_cadence_seconds: 60 } };
  const slots = WarroomOpsSchedule.expandSlotsForWindow(registry, 24, NOW);
  assert.ok(slots.length <= 1440, `expected at most 1440 slots/day for a 1-minute cadence, got ${slots.length}`);
  assert.ok(slots.length > 1000, `expected close to a full day of 1-minute slots, got ${slots.length}`);
});

test('collapseToOnePerJob: sub-hourly job collapses to exactly one row (Cron Today is one dot per job)', () => {
  const cronRegistry = { jobs: { pj: { job_id: 'process-jobs', display_name: 'Process jobs', cron: '* * * * *', expected_cadence_seconds: 60 } } };
  const jobsRegistry = { jobs: {} };
  const rows = WarroomOpsJoin.buildOpsRows({ cronRegistry, jobsRegistry, runSummaryByJobId: {}, windowHours: 24, now: NOW });
  const collapsed = WarroomOpsJoin.collapseToOnePerJob(rows, NOW);
  assert.equal(collapsed.length, 1);
  assert.equal(collapsed[0].job, 'process-jobs');
});

test('collapseToOnePerJob: picks the most recent past slot over any future one', () => {
  const rows = [
    { job: 'x', scheduled_at: '2026-08-27T10:00:00Z', state: 'ran_ok' },
    { job: 'x', scheduled_at: '2026-08-27T17:00:00Z', state: 'grace_unset' }, // most recent past (now=18:00Z)
    { job: 'x', scheduled_at: '2026-08-27T20:00:00Z', state: 'pending' }
  ];
  const collapsed = WarroomOpsJoin.collapseToOnePerJob(rows, NOW);
  assert.equal(collapsed.length, 1);
  assert.equal(collapsed[0].scheduled_at, '2026-08-27T17:00:00Z');
});

test('buildOpsRows: response rows carry every field the card contract names', () => {
  const cronRegistry = { jobs: { edgar: { job_id: 'edgar-scraper', grace_job_id: 'sec-edgar', display_name: 'SEC EDGAR', cron: '30 6 * * *', expected_cadence_seconds: 86400 } } };
  const jobsRegistry = { jobs: { 'SEC EDGAR': { job_id: 'sec-edgar', grace_minutes: 'UNSET' } } };
  const rows = WarroomOpsJoin.buildOpsRows({ cronRegistry, jobsRegistry, runSummaryByJobId: {}, windowHours: 24, now: NOW });
  const row = rows[0];
  for (const field of ['job', 'scheduled_at', 'run_id', 'started_at', 'finished_at', 'exit_code', 'trigger', 'state']) {
    assert.ok(field in row, `row missing field "${field}"`);
  }
});
