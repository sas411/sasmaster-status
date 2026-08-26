// WARROOM-CLOCK-001 — frozen-clock unit suite. This IS the card's C7 gold
// example: every assertion below is the literal VERIFY(a)-(i) fixture from
// task-cards/WARROOM-CLOCK-001.md §5, run against a frozen `now`, not a
// visual/manual check. Builder ran this as a sanity pass; the official C7
// human-verified sign-off and MAINTAINER's independent VERIFY re-run are
// separate from this file existing.
import test from 'node:test';
import assert from 'node:assert/strict';
import WarroomClock from '../lib/warroom-clock.js';

const NOW = '2026-08-23T09:54:00Z'; // = 05:54 AM ET, UTC-04:00 (EDT)

test('(a) future timestamp -> clock skew error, not a value', () => {
  const r = WarroomClock.toEt('2026-08-23T16:15:00Z', NOW);
  assert.deepEqual(r, { state: 'error', reason: 'clock skew' });
});

test('(b) TELEMETRY 06:55 AM event resolved to future UTC -> same error object', () => {
  const r = WarroomClock.toEt('2026-08-23T10:55:00Z', NOW);
  assert.deepEqual(r, { state: 'error', reason: 'clock skew' });
});

test('(c) sortFeedDesc — canonical descending sort, error row kept at head not dropped', () => {
  const rows = [
    { id: 'r10:55', ts: '2026-08-23T10:55:00Z' },
    { id: 'r09:55', ts: '2026-08-23T09:55:00Z' },
    { id: 'r04:10', ts: '2026-08-23T04:10:00Z' },
    { id: 'r01:48', ts: '2026-08-23T01:48:00Z' },
    { id: 'r03:25', ts: '2026-08-23T03:25:00Z' },
    { id: 'r08:00', ts: '2026-08-23T08:00:00Z' },
    { id: 'r09:35', ts: '2026-08-23T09:35:00Z' }
  ];
  const sorted = WarroomClock.sortFeedDesc(rows, 'ts', NOW);
  assert.deepEqual(sorted.map(r => r.id), [
    'r10:55', 'r09:55', 'r09:35', 'r08:00', 'r04:10', 'r03:25', 'r01:48'
  ]);
  // Card asserts only row[0] (10:55Z) is error-flagged and the order holds —
  // it does not assert every other row's clock state. r09:55 (09:55Z) is
  // itself 60s after the frozen now (09:54:00Z) and is legitimately also
  // skew-flagged under the same C5 rule; asserting it 'ok' would be a bug
  // in this test, not in sortFeedDesc.
  assert.equal(sorted[0]._clockState, 'error'); // 10:55Z is future vs 09:54Z now
  assert.equal(sorted[1]._clockState, 'error'); // 09:55Z is also future vs 09:54Z now, by 60s
  for (const r of sorted.slice(2)) assert.equal(r._clockState, 'ok');
});

test('(d) row with no canonical field -> ERROR, not interleaved at arbitrary index', () => {
  const rows = [
    { id: 'has-ts', ts: '2026-08-23T08:00:00Z' },
    { id: 'no-ts' }
  ];
  const sorted = WarroomClock.sortFeedDesc(rows, 'ts', NOW);
  const missing = sorted.find(r => r.id === 'no-ts');
  assert.equal(missing._clockState, 'error');
  assert.equal(missing._clockReason, 'no canonical timestamp no-ts');
});

test('(e) DST — EST offset in January, EDT offset in August', () => {
  assert.equal(WarroomClock.toEt('2026-01-15T12:00:00Z', '2026-01-15T23:00:00Z').offset, 'UTC−05:00');
  assert.equal(WarroomClock.toEt('2026-08-23T12:00:00Z', NOW.replace('09:54','23:59')).offset, 'UTC−04:00');
});

test('(f) rollingWindow(31, now) and a June-only fixture yields 0 rows in window', () => {
  const w = WarroomClock.rollingWindow(31, NOW);
  assert.deepEqual(w, { from: '2026-07-23', to: '2026-08-23' });
  const juneRows = [
    { id: 'j1', ts: '2026-06-05T00:00:00Z' },
    { id: 'j2', ts: '2026-06-20T00:00:00Z' }
  ];
  const inWindow = juneRows.filter(r => WarroomClock.inRollingWindow(r.ts, 31, NOW));
  assert.equal(inWindow.length, 0);
});

test('(g) 6-month forecast — first bucket is the current ET month', () => {
  const buckets = WarroomClock.monthBuckets(6, NOW);
  assert.equal(buckets[0], '2026-08');
  assert.equal(buckets[5], '2026-03'); // Aug,Jul,Jun,May,Apr,Mar — 6 buckets back from Aug inclusive
});

test('(h) CANVAS TODAY excludes an artifact built on a prior ET calendar day', () => {
  const builtJun15 = '2026-06-15T14:00:00Z';
  assert.equal(WarroomClock.isSameEtCalendarDay(builtJun15, NOW), false);
  const builtToday = '2026-08-23T08:00:00Z';
  assert.equal(WarroomClock.isSameEtCalendarDay(builtToday, NOW), true);
});

test('(i) root-cause branch — a real past cache write renders a real value, not ERROR', () => {
  const r = WarroomClock.toEt('2026-08-23T08:15:00Z', NOW);
  assert.equal(r.state, 'ok');
  assert.equal(r.display, '04:15 AM ET (UTC−04:00)');
  const age = WarroomClock.ageFrom('2026-08-23T08:15:00Z', NOW);
  assert.equal(age.display, '1h 39m ago');
});
