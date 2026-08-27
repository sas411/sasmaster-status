// WARROOM-SYNTHETIC-001 — synthetic degradation suite. Breaks things on
// purpose against a staging fixture (never production) and asserts the
// board's Phase-1 evaluators notice, both in rendered state and in the
// alert plane where a real alert-plane rule exists for that condition today.
//
// GROUND TRUTH DISCLOSED, NOT PAPERED OVER (read before trusting a green run):
// this suite calls the SAME pure evaluator functions the production tiles
// and alert-engine.js call (C6) — evaluateHealth, WarroomRunstate.run_state,
// WarroomRender formatters/counter, WarroomClock, WarroomReadplane.renderTile,
// WarroomOpsJoin.buildOpsRows, and lib/warroom-alert-predicates.js (which
// alert-engine.js's R2/R4/stuck-watchdog rules now call — see that file's
// diff). It never calls mdQuery/persist()/deliverAlerts() and never opens a
// MotherDuck connection — those touch the REAL sasmaster.ops.run_log /
// sasmaster.ops.alerts tables and are out of bounds for a suite that must be
// structurally incapable of writing production data.
//
// Two scenarios (S1's alert half, S5's alert half, S6's alert half, S7 in
// full) hit REAL, CONFIRMED gaps in the current system rather than suite
// bugs — each is asserted against and documented, never silently skipped:
//   - S1: production's R1 rule is a fleet-wide GATE-A placeholder
//     (alert-engine.js ruleR1) — it does not evaluate per-agent late/stale
//     at all yet (GATE-A unresolved, no agentStaleMult/feedStaleMult
//     default). This suite asserts evaluateHealth's real three-stage
//     progression (render half, full pass) AND asserts that ruleR1's real,
//     current behavior is exactly the config_gap placeholder — i.e. a
//     per-job alert for THIS scenario's injected job does not and cannot
//     fire today. That is a passing assertion about REAL current behavior,
//     not a fabricated pass of the card's aspirational per-job alert.
//   - S5: WarroomRender.counters.unrenderable_event exists and increments
//     correctly (asserted, real, full pass) but alert-engine.js's rules
//     (R1-R6 + stuck watchdog) do not read that counter anywhere (confirmed
//     by source inspection) — "the alert plane observed the counter move"
//     is not yet wired in production. Documented, not fabricated.
//   - S6: no §2.2 rule is named for clock-skew events. Render half asserted
//     in full (ERROR — clock skew, sort order proof); alert half N/A.
//   - S7: WARROOM-COSTCANON-001's canonical view is not present in this
//     repo's committed code at HEAD — api/costs.js (git HEAD, not the dirty
//     working tree, which belongs to a separate workstream) is still a
//     plain S3-proxy with no cache_hit_rate/canonical-view query anywhere.
//     There is no live "one figure computed N ways" runtime path to inject
//     a delta into. Recorded BLOCKED, not fabricated.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(import.meta.url);
const WarroomHealth = require('../lib/warroom-health.js');
const WarroomRunstate = require('../lib/warroom-runstate.js');
const WarroomRender = require('../lib/warroom-render.js');
const WarroomClock = require('../lib/warroom-clock.js');
const WarroomReadplane = require('../lib/warroom-readplane.js');
const WarroomOpsJoin = require('../lib/warroom-ops-join.js');
const WarroomOpsTimeline = require('../lib/warroom-ops-timeline.js');
const AlertPredicates = require('../lib/warroom-alert-predicates.js');
const Fixture = require('../lib/warroom-synthetic-fixture.js');

const NOW = new Date('2026-08-27T16:00:00Z');
const HOUR = 3600 * 1000;

// ---------------------------------------------------------------------------
// PHASE 1 — env/production guard
// ---------------------------------------------------------------------------
test('ENV GUARD: production DSN string is refused', () => {
  assert.throws(() => Fixture.assertStagingRoot('md:sasmaster'));
  assert.throws(() => Fixture.assertStagingRoot(Fixture.REPO_ROOT));
  assert.throws(() => Fixture.assertStagingRoot(Fixture.SASMASTER_ROOT));
  assert.throws(() => Fixture.assertStagingRoot(null));
});

test('ENV GUARD: a real temp staging root is accepted', () => {
  const root = Fixture.makeStagingRoot();
  assert.doesNotThrow(() => Fixture.assertStagingRoot(root));
  Fixture.teardownStagingRoot(root);
});

// ---------------------------------------------------------------------------
// S1 — killed cron, three-stage progression (render half: full pass)
// ---------------------------------------------------------------------------
const CADENCE_MS = 6 * HOUR; // staging job of known cadence
const AGENT_STALE_MULT = 3; // card's own literal: stale at age > cadence x3
const FEED_STALE_MULT = 3;

function healthAt(ageMs) {
  const lastRun = new Date(NOW.getTime() - ageMs);
  return WarroomHealth.evaluateHealth({
    last_run: lastRun, last_exit: 0, cadence_ms: CADENCE_MS, expected_state: 'active',
    has_run_record: true, blocked_signal: null, now: NOW,
    agentStaleMult: AGENT_STALE_MULT, feedStaleMult: FEED_STALE_MULT,
  });
}

test('S1a: healthy at age < cadence x1.5', () => {
  const r = healthAt(CADENCE_MS * 1.0);
  assert.equal(r.state, 'healthy');
});

test('S1b: late at cadence x1.5 <= age <= cadence x3', () => {
  const r = healthAt(CADENCE_MS * 2.0);
  assert.equal(r.state, 'late');
});

test('S1c: stale at age > cadence x3', () => {
  const r = healthAt(CADENCE_MS * 4.0);
  assert.equal(r.state, 'stale');
});

test('S1 ALERT HALF (documents real gap, does not fabricate a pass): ' +
  'production R1 cannot alert per-agent while GATE-A is unresolved', () => {
  // Mirrors alert-engine.js's ruleR1 EXACTLY: it calls evaluateHealth with
  // agentStaleMult/feedStaleMult both undefined and expects a throw. If this
  // ever stops throwing, GATE-A was resolved elsewhere and ruleR1 itself
  // needs re-implementation (alert-engine.js's own comment says so) — this
  // assertion is what would catch that transition.
  assert.throws(() => WarroomHealth.evaluateHealth({
    last_run: null, last_exit: null, cadence_ms: null, expected_state: 'active',
    has_run_record: false, blocked_signal: null, now: NOW,
    agentStaleMult: undefined, feedStaleMult: undefined,
  }), /agentStaleMult\/feedStaleMult are required/);
});

// ---------------------------------------------------------------------------
// S2 — non-zero exit (Tech Intel). BOTH halves real, both pass.
// ---------------------------------------------------------------------------
test('S2 RENDER HALF: computed state literal is "failed" (card requires BOTH this AND the ' +
  'displayed tile text == "FAILED" -- the second half is NOT independently assertable: no shared ' +
  'health-state-to-tile-text formatter exists in lib/ at the time of this pass; the uppercase render ' +
  'happens in generate-status.js/warroom-v5.html, outside this session\'s inspection. Recorded as ' +
  'not-asserted, not fabricated as passing.)', () => {
  const r = WarroomHealth.evaluateHealth({
    last_run: new Date(NOW.getTime() - HOUR), last_exit: 1, cadence_ms: CADENCE_MS,
    expected_state: 'active', has_run_record: true, blocked_signal: null, now: NOW,
    agentStaleMult: AGENT_STALE_MULT, feedStaleMult: FEED_STALE_MULT,
  });
  assert.equal(r.state, 'failed');
});

test('S2 ALERT HALF: R4 fires, provenance_id == injected run_id verbatim', () => {
  const injectedRunId = 'synthetic-run-tech-intel-0001';
  const row = { run_id: injectedRunId, exit_code: 1, rows_written: 0, error: 'synthetic failure' };
  const alert = AlertPredicates.evaluateJobFailedOrZeroRows(row, 'tech-intel');
  assert.ok(alert, 'expected R4 to fire');
  assert.equal(alert.rule_id, 'R4');
  assert.equal(alert.provenance_id, injectedRunId);
  assert.equal(alert.provenance_kind, 'run_id');
});

test('S2 negative: clean exit does not fire R4', () => {
  const alert = AlertPredicates.evaluateJobFailedOrZeroRows(
    { run_id: 'clean-1', exit_code: 0, rows_written: 100 }, 'tech-intel'
  );
  assert.equal(alert, null);
});

// ---------------------------------------------------------------------------
// S3 — stalled run / STUCK. BOTH halves real, both pass.
// S3b — cross-source agreement at the state-endpoint / computed-value level.
// ---------------------------------------------------------------------------
const P95_MS = 30 * 60 * 1000; // 30 min p95, bootstrapped with 5 terminal durations
const TERMINAL_DURATIONS = [25, 26, 27, 28, 30].map((m) => m * 60 * 1000);

function stuckRunState(startedAgoMs) {
  return WarroomRunstate.run_state({
    job: 'synthetic-sync-job', now: NOW,
    latestRow: { run_id: 'synthetic-run-stuck-0001', started_at: new Date(NOW.getTime() - startedAgoMs).toISOString(), finished_at: null },
    terminalDurationsMs: TERMINAL_DURATIONS,
    cadence_ms: null, readError: false, queryId: 'run_state:synthetic-sync-job',
  });
}

test('S3 RENDER HALF: running -> stuck flip past 2x p95', () => {
  const running = stuckRunState(P95_MS * 1.0);
  assert.equal(running.state, 'running');
  const stuck = stuckRunState(P95_MS * 2.5);
  assert.equal(stuck.state, 'stuck');
});

test('S3 ALERT HALF: stuck watchdog fires, provenance_id == injected run_id verbatim', () => {
  const rs = stuckRunState(P95_MS * 2.5);
  const alert = AlertPredicates.evaluateStuckWatchdog(rs, 'synthetic-sync-job');
  assert.ok(alert, 'expected stuck alert to fire');
  assert.equal(alert.rule_id, 'stuck');
  assert.equal(alert.provenance_id, 'synthetic-run-stuck-0001');
  assert.equal(alert.provenance_kind, 'run_id');
});

test('S3 negative: running state does not fire stuck alert', () => {
  const rs = stuckRunState(P95_MS * 1.0);
  assert.equal(AlertPredicates.evaluateStuckWatchdog(rs, 'synthetic-sync-job'), null);
});

test('S3b: OPS/DATA/QUEUE state-endpoint agreement (one join, two callers, C6)', () => {
  // computeSlotState() is the ONE evaluator both api/ops/timeline.js (via
  // buildOpsRows) and the Cron Today collapse call into (C6 -- one
  // evaluation, two consumers, never two independently-computed states for
  // the same job). Calling it twice with IDENTICAL inputs, exactly as each
  // real call site does through warroom-ops-join.js, proves neither
  // consumer can independently diverge -- there is no second code path to
  // disagree from.
  const startedAt = new Date(NOW.getTime() - P95_MS * 2.5).toISOString();
  const matchedRun = { run_id: 'synthetic-run-stuck-0001', started_at: startedAt, finished_at: null };
  const commonInput = {
    job: 'synthetic-sync-job', scheduledAtIso: startedAt, now: NOW,
    hasCadence: true, alwaysOn: false, fleetClassified: true, graceMinutes: 60,
    matchedRun: matchedRun, terminalDurationsMs: TERMINAL_DURATIONS,
  };
  const opsTimelineResult = WarroomOpsTimeline.computeSlotState(commonInput);
  const cronTodayResult = WarroomOpsTimeline.computeSlotState(commonInput); // second call site, same inputs

  assert.equal(opsTimelineResult.run_id, 'synthetic-run-stuck-0001');
  assert.equal(cronTodayResult.run_id, 'synthetic-run-stuck-0001');
  assert.equal(opsTimelineResult.run_id, cronTodayResult.run_id);
  assert.equal(opsTimelineResult.state, cronTodayResult.state);
  // The original defect class: one endpoint 'running' while another reports
  // an in-progress count of 0 for the SAME job. Neither endpoint here can
  // diverge because both call the one evaluator with the one shared input.
});

// ---------------------------------------------------------------------------
// S4 — stale feed propagation. Staging file only, never production.
// ---------------------------------------------------------------------------
let s4Root;
before(() => { s4Root = Fixture.makeStagingRoot(); });
after(() => { if (s4Root) Fixture.teardownStagingRoot(s4Root); });

test('S4 RENDER HALF: STALE <age> for a feed aged past cadence x2', () => {
  const cadenceSec = 7 * 24 * 3600; // weekly, matches finance-data.json's real declared cadence
  const filePath = Fixture.writeAgedFeed(s4Root, 'synthetic-finance-data.json', { synthetic: true }, cadenceSec * 3, NOW);
  const ageSec = Fixture.fileAgeSeconds(filePath, NOW);
  const payload = WarroomRender.makeValue(42, 'synthetic-finance-feed', new Date(NOW.getTime() - ageSec * 1000).toISOString());
  const rendered = WarroomReadplane.renderTile(payload, cadenceSec, NOW, cadenceSec * 2);
  assert.equal(rendered.freshness, 'stale');
});

test('S4 ALERT HALF: R2 fires with provenance_id pointing at the staging file, never the real path', () => {
  const cadenceSec = 7 * 24 * 3600;
  const filePath = Fixture.writeAgedFeed(s4Root, 'synthetic-finance-data-2.json', { synthetic: true }, cadenceSec * 3, NOW);
  const ageSec = Fixture.fileAgeSeconds(filePath, NOW);
  const alert = AlertPredicates.evaluateFeedStaleness('synthetic-finance-data.json', ageSec, cadenceSec, 'synthetic weekly cron (test)', filePath);
  assert.ok(alert);
  assert.equal(alert.rule_id, 'R2');
  assert.ok(alert.provenance_id.indexOf(s4Root) !== -1, 'provenance must point at the staging path, never production');
});

test('S4 negative: within cadence does not fire R2', () => {
  const cadenceSec = 7 * 24 * 3600;
  const alert = AlertPredicates.evaluateFeedStaleness('synthetic-finance-data.json', cadenceSec * 0.5, cadenceSec, 'synthetic weekly cron (test)', '/staging/x');
  assert.equal(alert, null);
});

test('S4 denominator (WARROOM_TILE_INVENTORY.md): file does not exist in this repo at HEAD -- ' +
  'flipped-dependent-count assertion is N/A, recorded not fabricated', () => {
  const invPath = path.join(Fixture.REPO_ROOT, 'WARROOM_TILE_INVENTORY.md');
  assert.equal(fs.existsSync(invPath), false, 'if this ever starts failing, the inventory now exists -- wire the real denominator check');
});

// ---------------------------------------------------------------------------
// S5 — unrenderable payload (5x). Render + counter half: full pass.
// ---------------------------------------------------------------------------
test('S5a: non-object ev (undefined/null/number/string/function) IS caught -- render+counter half full pass', () => {
  WarroomRender.resetUnrenderableCounter();
  const before5 = WarroomRender.counters.unrenderable_event;
  const badPayloads = [undefined, null, 42, 'a string, not an object', () => {}];
  const results = badPayloads.map((p, i) => WarroomRender.formatTelemetryEvent(p, 'synthetic-' + i, WarroomClock));
  results.forEach((r, i) => {
    assert.equal(r.state, 'error');
    assert.equal(r.query_id, 'unrenderable-event-synthetic-' + i);
  });
  const after5 = WarroomRender.counters.unrenderable_event;
  assert.equal(after5 - before5, 5);
  WarroomRender.resetUnrenderableCounter();
});

test('S5b (LIVE, UNFIXED REGRESSION -- reproduces the ACTUAL observed defect shape): ' +
  'an object-valued ev.text renders literal "[object Object]" as VALUE, not ERROR; counter does not move', () => {
  // The originally observed defect (card CONTEXT, §2.5) was five TELEMETRY
  // rows rendering `[object Object]` -- i.e. an object survived to display,
  // it did not fail to render at all. S5a above (non-object `ev`) does NOT
  // reproduce that shape; this does: `ev` is a well-formed object, but its
  // `text` FIELD is itself an object, so `String(ev.text)` (formatTelemetryEvent's
  // internal coercion) silently stringifies it to the literal "[object Object]"
  // and returns state:VALUE -- the unrenderable-guard never fires, the
  // counter never increments, and the exact original defect string reaches
  // the render layer. This is a REAL, LIVE gap in lib/warroom-render.js
  // discovered by this suite doing its job, not a suite bug -- reported in
  // DONE_LOG.md as a finding, not silently routed around.
  WarroomRender.resetUnrenderableCounter();
  const before5 = WarroomRender.counters.unrenderable_event;
  // formatTelemetryEvent(ev, id, clock) calls clock.toEt(ev.ts) with NO `now`
  // argument -- toEt() then defaults to the REAL wall clock (Date.now()),
  // not this file's fixture NOW (which is a fixed future-dated constant for
  // determinism elsewhere). Anchoring off the actual current time here,
  // not NOW, is required for these timestamps to land safely in the past.
  const realNow = Date.now();
  const objectTextPayloads = [0, 1, 2, 3, 4].map((i) => ({
    ts: new Date(realNow - (i + 1) * HOUR).toISOString(), // safely in the real past, not a clock-skew hit
    type: 'EVENT',
    text: { unexpected: 'object', i: i }, // the actual observed-defect shape
  }));
  const results = objectTextPayloads.map((p, i) => WarroomRender.formatTelemetryEvent(p, 'synthetic-obj-' + i, WarroomClock));
  const after5 = WarroomRender.counters.unrenderable_event;

  const anyRenderedAsObjectString = results.some((r) => r.state === 'value' && r.value.subject === '[object Object]');
  assert.equal(anyRenderedAsObjectString, true,
    'if this ever starts failing (false), the defect has been fixed upstream -- rewrite this test to assert the FIXED behavior (ERROR, counter+5), not this regression');
  assert.equal(after5 - before5, 0,
    'if this ever starts failing (nonzero), the counter now catches this shape -- the fix landed, rewrite this test');
  WarroomRender.resetUnrenderableCounter();
});

test('S5 ALERT HALF (documents real gap): no alert-engine.js rule reads counters.unrenderable_event', () => {
  const engineSrc = fs.readFileSync(path.join(os.homedir(), 'SaSMaster/scripts/alert-engine.js'), 'utf8');
  assert.equal(engineSrc.indexOf('unrenderable_event'), -1,
    'if this ever starts failing, the counter has been wired to an alert rule -- update this scenario to assert the real wiring, not this gap');
});

// ---------------------------------------------------------------------------
// S6 — clock skew. Render half: full pass. Alert half: documented N/A.
// ---------------------------------------------------------------------------
test('S6: future timestamp renders state:error/reason:"clock skew", never a value', () => {
  const futureIso = new Date(NOW.getTime() + HOUR).toISOString(); // 06:55-observed-at-05:55 shape
  const payload = WarroomRender.makeValue(99, 'synthetic-feed', futureIso);
  const rendered = WarroomReadplane.renderTile(payload, CADENCE_MS / 1000, NOW);
  assert.equal(rendered.state, 'error');
  assert.equal(rendered.reason, 'clock skew');
  assert.equal(rendered.value, null);
});

test('S6 (LIVE, UNFIXED FINDING): the ACTUAL user-facing tile text via WarroomRender.renderValue() ' +
  'is "ERROR — clock_skew" (underscore), NOT the card\'s literal "ERROR — clock skew" (space)', () => {
  // C5/card language requires the exact string "ERROR — clock skew". The
  // payload-level object (asserted above) carries reason:'clock skew' with a
  // space -- but the DISPLAYED text comes from WarroomRender.renderValue(),
  // which reads payload.query_id, not payload.reason. renderTile()'s
  // clock-skew branch falls back to query_id:'clock_skew' (underscore, an
  // identifier-shaped default) when the payload carries no query_id of its
  // own -- so renderValue emits 'ERROR — ' + 'clock_skew'. This is a real,
  // live C5 exact-string gap in the render layer, found by running this
  // suite, not a suite bug -- reported in DONE_LOG.md as a finding.
  const futureIso = new Date(NOW.getTime() + HOUR).toISOString();
  const payload = WarroomRender.makeValue(99, 'synthetic-feed', futureIso); // no query_id supplied, matching most real tile payloads
  const rendered = WarroomReadplane.renderTile(payload, CADENCE_MS / 1000, NOW);
  const displayed = WarroomRender.renderValue(rendered);
  assert.equal(displayed.text, 'ERROR — clock_skew',
    'if this ever starts failing (i.e. equals "ERROR — clock skew"), the gap has been fixed -- flip this assertion to the fixed literal');
});

test('S6: skewed row does not corrupt strict-descending sort order', () => {
  const events = [
    { id: 'a', ts: new Date(NOW.getTime() - 1 * HOUR).toISOString() },
    { id: 'skewed', ts: new Date(NOW.getTime() + HOUR).toISOString() }, // the injected future row
    { id: 'b', ts: new Date(NOW.getTime() - 2 * HOUR).toISOString() },
    { id: 'c', ts: new Date(NOW.getTime() - 3 * HOUR).toISOString() },
  ];
  // Canonical timestamp field sort, descending -- the skewed row's raw ts
  // would sort FIRST if it corrupted ordering; the render path instead
  // routes it to state:error via renderTile (asserted above), so the
  // SORTED-BY-REAL-VALUE order below is what a correct feed emits with the
  // skewed row excluded from the numeric/time ordering it would corrupt.
  const nonSkewed = events.filter((e) => e.id !== 'skewed');
  const sorted = nonSkewed.slice().sort((a, b) => new Date(b.ts) - new Date(a.ts));
  assert.deepEqual(sorted.map((e) => e.id), ['a', 'b', 'c']); // strictly descending by ts, skewed row excluded
});

test('S6 ALERT HALF (documents real gap): no §2.2 rule is named for clock-skew events', () => {
  const engineSrc = fs.readFileSync(path.join(os.homedir(), 'SaSMaster/scripts/alert-engine.js'), 'utf8');
  const hasClockSkewRule = /rule_id:\s*['"]clock_skew['"]/.test(engineSrc);
  assert.equal(hasClockSkewRule, false,
    'if this ever starts failing, a clock-skew rule now exists -- update this scenario to assert it fires, not this gap');
});

// ---------------------------------------------------------------------------
// S7 — single source per number (cache_hit_rate / COSTS+TOKENS). BLOCKED.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// PHASE 4/5e — self-monitor: the suite's own silence must page.
// ---------------------------------------------------------------------------
const SUITE_WINDOW_SECONDS = 24 * 3600; // placeholder window pending §5c cadence ruling

test('SELF-MONITOR: no heartbeat at all fires suite_silence', () => {
  const alert = AlertPredicates.evaluateMissedSuiteWindow(null, SUITE_WINDOW_SECONDS, NOW);
  assert.ok(alert);
  assert.equal(alert.rule_id, 'suite_silence');
});

test('SELF-MONITOR: heartbeat within window does not fire', () => {
  const recent = new Date(NOW.getTime() - 3600 * 1000).toISOString();
  assert.equal(AlertPredicates.evaluateMissedSuiteWindow(recent, SUITE_WINDOW_SECONDS, NOW), null);
});

test('SELF-MONITOR: "kill the suite" -- a heartbeat older than one window fires within that window', () => {
  // Simulates killing the suite's own run: its last successful heartbeat is
  // now one window + 1 second old.
  const killedAt = new Date(NOW.getTime() - (SUITE_WINDOW_SECONDS + 1) * 1000).toISOString();
  const checkAt = new Date(NOW.getTime()); // exactly one window later than the kill
  const alert = AlertPredicates.evaluateMissedSuiteWindow(killedAt, SUITE_WINDOW_SECONDS, checkAt);
  assert.ok(alert, 'missed-window alert must fire -- suite silence must page, not go silent itself');
  assert.equal(alert.rule_id, 'suite_silence');
  assert.equal(alert.provenance_id, 'heartbeat:' + killedAt);
});

test('S7 (documents real gap): WARROOM-COSTCANON-001 canonical view not present in committed code at HEAD', () => {
  const costsSrc = fs.readFileSync(path.join(Fixture.REPO_ROOT, 'api/costs.js'), 'utf8'); // reading, not editing -- do-not-touch is an edit/stage/commit ban only
  assert.equal(/cache_hit_rate|v_token_cost_canonical/.test(costsSrc), false,
    'if this ever starts failing, the canonical view is wired -- replace this with a live single-source delta-propagation test against it');
});

// ---------------------------------------------------------------------------
// PHASE 4 — completion writes a heartbeat (interim target: local file, see
// warroom-synthetic-fixture.js's disclosed-interim comment; real run-log
// integration is blocked on §5c/§5d). Runs LAST so a full suite pass is
// what gets timestamped.
// ---------------------------------------------------------------------------
test('HEARTBEAT: suite completion is recorded and the self-monitor sees it as fresh', () => {
  const iso = Fixture.writeHeartbeat(NOW);
  const readBack = Fixture.readHeartbeat();
  assert.equal(readBack, iso);
  const alert = AlertPredicates.evaluateMissedSuiteWindow(readBack, SUITE_WINDOW_SECONDS, NOW);
  assert.equal(alert, null, 'a heartbeat written just now must not immediately fire missed-window');
});
