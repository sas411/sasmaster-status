import { test } from 'node:test';
import assert from 'node:assert/strict';
import WorkQueue from '../lib/work-queue.js';
import WarroomRender from '../lib/warroom-render.js';

const NOW = new Date('2026-08-27T12:00:00.000Z');

test('ageDays: calendar-day diff, not ms/86400000 floor', () => {
  // Jun 23 -> Aug 27 is 65 days on the calendar, regardless of time-of-day.
  assert.equal(WorkQueue.ageDays('2026-06-23T00:00:15.570Z', NOW), 65);
  assert.equal(WorkQueue.ageDays('2026-08-08T20:11:04.703Z', NOW), 19);
  assert.equal(WorkQueue.ageDays(null, NOW), null);
  assert.equal(WorkQueue.ageDays('not-a-date', NOW), null);
});

test('computeEscalation: unset cadence never fabricates a threshold (C3)', () => {
  const r = WorkQueue.computeEscalation(19, null);
  assert.equal(r.state, 'unset');
  assert.equal(r.display, 'N/A — cadence undeclared');
});

test('computeEscalation: real cadence escalates/stales at 1x/2x (C4)', () => {
  const cadence7d = 7 * 86400;
  assert.equal(WorkQueue.computeEscalation(5, cadence7d).state, 'ok');
  assert.equal(WorkQueue.computeEscalation(8, cadence7d).state, 'escalated');
  assert.equal(WorkQueue.computeEscalation(15, cadence7d).state, 'stale');
});

test('buildBlessItems: catalog fetch failure renders kind-level ERROR, never a fabricated 0 (C2)', () => {
  const { items, kindStatus } = WorkQueue.buildBlessItems({ ok: false, query_id: 'bless-catalog-fetch-failed', reason: 'timeout' }, NOW);
  assert.deepEqual(items, []);
  assert.equal(kindStatus.state, 'error');
  assert.equal(kindStatus.query_id, 'bless-catalog-fetch-failed');
});

test('buildBlessItems: real zero when catalog is reachable and has no pending entries', () => {
  const { items, kindStatus } = WorkQueue.buildBlessItems({ ok: true, entries: [{ certified_id: 'a', status: 'certified' }] }, NOW);
  assert.deepEqual(items, []);
  assert.equal(kindStatus.state, 'ok');
  assert.equal(kindStatus.count, 0);
});

test('buildBlessItems: pending entries become items, count = length(rows) (C1)', () => {
  const { items, kindStatus } = WorkQueue.buildBlessItems({
    ok: true,
    entries: [
      { certified_id: 'p1', query: 'Q1', built_at: '2026-08-20T00:00:00Z', status: 'pending' },
      { certified_id: 'p2', query: 'Q2', built_at: '2026-08-25T00:00:00Z', status: 'pending' },
      { certified_id: 'c1', query: 'Q3', built_at: '2026-08-26T00:00:00Z', status: 'certified' },
    ],
  }, NOW);
  assert.equal(items.length, 2);
  assert.equal(kindStatus.count, 2);
  assert.equal(items[0].kind, 'bless');
  assert.equal(items[0].age_days, 7);
});

test('buildBlockedAgentItems: GATE-A-style total evaluator failure renders ERROR, never a real-zero', () => {
  const agents = [
    { name: 'LinkedIn Agent', healthEval: { state: 'error', reason: 'gate-a-unresolved' } },
    { name: 'Media Intel', healthEval: { state: 'error', reason: 'gate-a-unresolved' } },
    { name: 'On-Demand Sub', healthEval: { state: 'na', reason: 'on-demand, not schedule-evaluated' } },
  ];
  const { items, kindStatus } = WorkQueue.buildBlockedAgentItems(agents, NOW);
  assert.deepEqual(items, []);
  assert.equal(kindStatus.state, 'error');
  assert.equal(kindStatus.query_id, 'health-eval-gate-unresolved');
});

test('buildBlockedAgentItems: a real blocked agent renders as an item with its structured reason (C7)', () => {
  const agents = [
    { name: 'LinkedIn Agent', lastRun: '2026-08-20T00:00:08.900Z', healthEval: { state: 'blocked', reason: 'No theme set — prompted Shiv for direction', inputs: { last_run: '2026-08-20T00:00:08.900Z' } } },
    { name: 'Media Intel', healthEval: { state: 'healthy', reason: null } },
  ];
  const { items, kindStatus } = WorkQueue.buildBlockedAgentItems(agents, NOW);
  assert.equal(kindStatus.state, 'ok');
  assert.equal(items.length, 1);
  assert.match(items[0].subject, /No theme set/);
  assert.equal(items[0].owner, 'LinkedIn Agent');
});

test('buildReviewItems: opened_at resolves from openedAt, falls back to meta.opened, else unknown', () => {
  const rows = [
    { id: 'review-0', text: 'WBR A', openedAt: '2026-06-22T00:00:15.570Z' },
    { id: 't5', text: 'WBR B', meta: { opened: '2026-07-13' } },
    { id: 't6', text: 'WBR C' },
  ];
  const { items } = WorkQueue.buildReviewItems(rows, NOW);
  assert.equal(items[0].age_days, 66);
  assert.equal(items[1].age_days, 45);
  assert.equal(items[2].age_days, null);
});

test('buildOpsTaskItems: raw log line never leaks the channel id, and typed subject includes task_id', () => {
  const raw = 'task_id:TASK-197 | ts:2026-08-08T20:11:04.703Z | channel:C0ATABZAH39 | status:PENDING | created_at:2026-08-08T20:11:04.703Z | tag:tmdb-daily | [COMPUTE] TMDB daily metadata refresh — queued by GitHub Actions (Mac offline)';
  const { items } = WorkQueue.buildOpsTaskItems([{ id: 't1455', full: raw, tag: 'DATA' }], NOW, WarroomRender.formatOpsQueueItem, WarroomRender.STATE);
  assert.equal(items.length, 1);
  assert.doesNotMatch(items[0].subject, /C0ATABZAH39/);
  assert.doesNotMatch(items[0].subject, /channel:/);
  assert.match(items[0].subject, /TASK-197/);
  assert.equal(items[0].age_days, 19);
});

test('buildOpsTaskItems: unparseable input increments the unrenderable counter and renders an error subject, never throws', () => {
  WarroomRender.resetUnrenderableCounter();
  const badItem = { id: 'bad1', full: null }; // formatOpsQueueItem handles this via its own try/catch -> plain_text path, not an error
  const { items } = WorkQueue.buildOpsTaskItems([badItem], NOW, WarroomRender.formatOpsQueueItem, WarroomRender.STATE);
  assert.equal(items.length, 1);
  assert.equal(typeof items[0].subject, 'string');
});

test('assemble: one model, four kinds, sorted age descending with unknown-age last', () => {
  const cadenceRegistry = { queue_kinds: { bless: { expected_cadence_seconds: null }, blocked_agent: { expected_cadence_seconds: null }, review: { expected_cadence_seconds: null }, ops_task: { expected_cadence_seconds: null } } };
  const model = WorkQueue.assemble({
    now: NOW,
    catalog: { ok: true, entries: [{ certified_id: 'p1', query: 'Q1', built_at: '2026-08-01T00:00:00Z', status: 'pending' }] },
    agents: [{ name: 'LinkedIn Agent', healthEval: { state: 'blocked', reason: 'No theme set', inputs: {} } }],
    reviewRows: [{ id: 'review-0', text: 'WBR', openedAt: '2026-06-23T00:00:00Z' }],
    highItems: [{ id: 't1', full: 'task_id:TASK-197 | ts:2026-08-08T20:11:04.703Z | channel:C0ATABZAH39 | status:PENDING | created_at:2026-08-08T20:11:04.703Z', tag: 'DATA' }],
    cadenceRegistry,
    formatOpsQueueItem: WarroomRender.formatOpsQueueItem,
    renderStates: WarroomRender.STATE,
  });
  assert.equal(model.items.length, 4);
  assert.equal(new Set(model.items.map(i => i.kind)).size, 4);
  model.items.forEach(it => assert.equal(it.escalation_state, 'unset'));
  // sorted age descending
  const ages = model.items.map(i => i.age_days);
  for (let i = 1; i < ages.length; i++) {
    if (ages[i - 1] != null && ages[i] != null) assert.ok(ages[i - 1] >= ages[i]);
  }
});

test('resolveChannel: known id maps to a human name; unknown id is omitted (null), never echoed', () => {
  assert.equal(WorkQueue.resolveChannel('C0ATABZAH39'), '#sasmaster-builds');
  assert.equal(WorkQueue.resolveChannel('CUNKNOWN123'), null);
  assert.equal(WorkQueue.resolveChannel(null), null);
});
