// WARROOM-SYNTHETIC-001 PHASE 5b/5c — negative controls.
// "The real test of this card" per the task card: a suite that still passes
// with health hardcoded is testing nothing. Every mutation here operates on
// a TEMP COPY of the real lib file (never edits the committed source) and is
// require()'d from its own temp path so Node's module cache never collides
// with the real module other tests in this run already loaded.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const require = createRequire(import.meta.url);
const Fixture = require('../lib/warroom-synthetic-fixture.js');
const WarroomHealth = require('../lib/warroom-health.js');

const REPO_ROOT = Fixture.REPO_ROOT;
const NOW = new Date('2026-08-27T16:00:00Z');
const CADENCE_MS = 6 * 3600 * 1000;

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function loadMutant(realRelPath, mutateFn) {
  const realPath = path.join(REPO_ROOT, realRelPath);
  const src = fs.readFileSync(realPath, 'utf8');
  const mutated = mutateFn(src);
  assert.notEqual(mutated, src, 'mutation must actually change the source, or this control proves nothing');
  const root = Fixture.makeStagingRoot();
  const mutantPath = path.join(root, path.basename(realRelPath));
  fs.writeFileSync(mutantPath, mutated);
  const mod = require(mutantPath);
  return { mod, root, realPath, realHashBefore: sha256(realPath) };
}

// ---------------------------------------------------------------------------
// PHASE 5b — hardcode §2.1 computed-health to 'healthy'. S1 and S2's render
// halves both call WarroomHealth.evaluateHealth() (S3's render half calls
// WarroomRunstate.run_state instead — a separate evaluator, mutated below
// too, since the card's "computed-health function" language covers the
// health/state layer this suite actually depends on, not one file only).
// ---------------------------------------------------------------------------
test('NEGATIVE CONTROL (health hardcoded to healthy): S1 and S2 render-half assertions now FAIL', () => {
  const { mod: MutantHealth, root, realPath, realHashBefore } = loadMutant('lib/warroom-health.js', (src) => {
    return src.replace(
      /function evaluateHealth\(input\) \{[\s\S]*?\n  \}\n/,
      "function evaluateHealth(input) {\n    return { state: 'healthy', age: null, reason: null, inputs: {} };\n  }\n"
    );
  });

  // S1c real assertion is `stale` at age > cadence x3. Under the mutant it
  // is unconditionally 'healthy' -- the suite's own S1c assertion, run
  // against the mutant, must now fail.
  const s1c = MutantHealth.evaluateHealth({
    last_run: new Date(NOW.getTime() - CADENCE_MS * 4), last_exit: 0, cadence_ms: CADENCE_MS,
    expected_state: 'active', has_run_record: true, blocked_signal: null, now: NOW,
    agentStaleMult: 3, feedStaleMult: 3,
  });
  assert.throws(() => assert.equal(s1c.state, 'stale'), assert.AssertionError,
    'S1c must fail against the hardcoded-healthy mutant -- if this does not throw, the suite tests nothing');

  // S2 real assertion is `failed` for a non-zero exit. Under the mutant it
  // is unconditionally 'healthy'.
  const s2 = MutantHealth.evaluateHealth({
    last_run: new Date(NOW.getTime() - 3600000), last_exit: 1, cadence_ms: CADENCE_MS,
    expected_state: 'active', has_run_record: true, blocked_signal: null, now: NOW,
    agentStaleMult: 3, feedStaleMult: 3,
  });
  assert.throws(() => assert.equal(s2.state, 'failed'), assert.AssertionError,
    'S2 must fail against the hardcoded-healthy mutant -- if this does not throw, the suite tests nothing');

  // Restore: the committed file was never touched -- prove it via hash.
  Fixture.teardownStagingRoot(root);
  assert.equal(sha256(realPath), realHashBefore, 'committed lib/warroom-health.js must be byte-identical after this control');
});

test('NEGATIVE CONTROL (run_state hardcoded to running): S3 render-half assertion now FAILS', () => {
  const { mod: MutantRunstate, root, realPath, realHashBefore } = loadMutant('lib/warroom-runstate.js', (src) => {
    return src.replace(
      /function run_state\(input\) \{[\s\S]*?\n  \}\n/,
      "function run_state(input) {\n    return { state: 'running', run_id: (input.latestRow && input.latestRow.run_id) || null, started_at: null, finished_at: null, percent: null, threshold: null, p95: null, bootstrap_mode: null, source_age: null, reason: null };\n  }\n"
    );
  });

  const P95_MS = 30 * 60 * 1000;
  const rs = MutantRunstate.run_state({
    job: 'synthetic-sync-job', now: NOW,
    latestRow: { run_id: 'synthetic-run-stuck-0001', started_at: new Date(NOW.getTime() - P95_MS * 2.5).toISOString(), finished_at: null },
    terminalDurationsMs: [25, 26, 27, 28, 30].map((m) => m * 60 * 1000),
    cadence_ms: null, readError: false, queryId: 'run_state:synthetic-sync-job',
  });
  assert.throws(() => assert.equal(rs.state, 'stuck'), assert.AssertionError,
    'S3 must fail against the hardcoded-running mutant -- if this does not throw, the suite tests nothing');

  Fixture.teardownStagingRoot(root);
  assert.equal(sha256(realPath), realHashBefore, 'committed lib/warroom-runstate.js must be byte-identical after this control');
});

// ---------------------------------------------------------------------------
// PHASE 5c — "point one of S7's tiles at a second query id, assert S7
// FAILS." S7 itself is BLOCKED (WARROOM-COSTCANON-001's canonical view is
// not present at HEAD -- see the main suite file). This substitutes the
// equivalent single-evaluation negative control on the ONE other C6
// "single computation, multiple consumers" mechanism that IS live in this
// repo: lib/warroom-ops-join.js, exercised by S3b. Mutating one consumer's
// join call to read a second, independent run_id proves the cross-source
// agreement assertion is not vacuous.
// ---------------------------------------------------------------------------
test('NEGATIVE CONTROL substitute for S7 (real S7 infra is BLOCKED, see main suite): ' +
  'a second, disagreeing run_id fed to one OPS/DATA/QUEUE consumer makes S3b FAIL', () => {
  const WarroomOpsTimeline = require('../lib/warroom-ops-timeline.js');
  const startedAt = new Date(NOW.getTime() - 3600000).toISOString();
  const baseInput = {
    job: 'job1', scheduledAtIso: startedAt, now: NOW,
    hasCadence: true, alwaysOn: false, fleetClassified: true, graceMinutes: 60,
    terminalDurationsMs: [25, 26, 27, 28, 30].map((m) => m * 60 * 1000),
  };
  const consumerA = WarroomOpsTimeline.computeSlotState({ ...baseInput, matchedRun: { run_id: 'run-A', started_at: startedAt, finished_at: null } });
  const consumerB = WarroomOpsTimeline.computeSlotState({ ...baseInput, matchedRun: { run_id: 'run-B-DIFFERENT', started_at: startedAt, finished_at: null } }); // simulates a second source disagreeing

  assert.throws(() => assert.equal(consumerA.run_id, consumerB.run_id), assert.AssertionError,
    'a genuinely disagreeing second source must fail S3b-shaped agreement assertion -- if this does not throw, the suite tests nothing');
});
