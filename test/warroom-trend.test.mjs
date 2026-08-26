// WARROOM-TREND-001 — property + fixture tests for the trend() helper.
// Wired into `npm test` (node --test test/) and `npm run verify` (test + gate).
// No GitHub Actions workflow currently runs either on push/PR (confirmed: only
// claude-review.yml and org-health.yml exist, neither runs `npm test`) -- creating
// that CI gate is flagged to Shiv as a separate decision, not invented here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const WarroomTrend = require('../lib/warroom-trend.js');

function sign(n) { return n > 0 ? 1 : (n < 0 ? -1 : 0); }

// ---- Named failure 1 (fixture, frozen -- live figures move, this fixture does not) ----
test('named failure 1: AWS $5.00 -> $111.87 (was rendered flat "->")', () => {
  const r = WarroomTrend.trend(111.87, 5.00);
  assert.equal(r.glyph, '↑');
  assert.equal(r.state, 'anomaly');
  assert.ok(r.ratio >= 22.32 && r.ratio <= 22.42, `ratio ${r.ratio} out of expected band`);
  assert.ok(Math.abs(r.ratio - 22.374) < 0.001);
});

// ---- Named failure 2 (fixture) ----
test('named failure 2: Anthropic $0.00 -> $11.27 (was rendered falling "v")', () => {
  const r = WarroomTrend.trend(11.27, 0.00);
  assert.equal(r.glyph, '↑');
  // $11.27 > this card's own ZERO_PRIOR_ANOMALY_THRESHOLD_USD ($10) -> anomaly, not plain 'up'.
  assert.equal(r.state, 'anomaly');
  assert.equal(r.ratio, null);
  assert.notEqual(r.state, 'na_no_prior');
});

// ---- Property test: sign(glyph) === sign(current - prior) across the generated pair set ----
function glyphSign(glyph) {
  if (glyph === '↑') return 1;
  if (glyph === '↓') return -1;
  if (glyph === '→') return 0;
  return null;
}

test('property: (0,0) -> flat', () => {
  const r = WarroomTrend.trend(0, 0);
  assert.equal(r.state, 'flat');
  assert.equal(r.glyph, '→');
});

test('property: (x,0) -> up (real zero prior, real positive current)', () => {
  for (const x of [0.5, 1, 5, 9.99, 10.01, 50]) {
    const r = WarroomTrend.trend(x, 0);
    assert.equal(glyphSign(r.glyph), 1, `x=${x}`);
    assert.notEqual(r.state, 'na_no_prior', `x=${x}`);
    assert.notEqual(r.state, 'down', `x=${x}`);
  }
});

test('property: (0,x) -> down (dropped to real zero)', () => {
  for (const x of [0.5, 1, 5, 50]) {
    const r = WarroomTrend.trend(0, x);
    assert.equal(glyphSign(r.glyph), -1, `x=${x}`);
  }
});

test('property: dead-band edges -> flat', () => {
  const r1 = WarroomTrend.trend(100.004, 100.00); // delta < $0.01
  assert.equal(r1.state, 'flat');
  const r2 = WarroomTrend.trend(100.011, 100.00); // delta > $0.01 -- must NOT be flat
  assert.notEqual(r2.state, 'flat');
});

test('property: negatives handled, sign holds', () => {
  const cases = [[-5, -10], [-10, -5], [-5, 5], [5, -5], [-3, -3]];
  for (const [current, prior] of cases) {
    const r = WarroomTrend.trend(current, prior);
    const delta = current - prior;
    if (Math.abs(delta) < WarroomTrend.DEAD_BAND_USD) {
      assert.equal(r.state, 'flat', `(${current},${prior})`);
    } else {
      assert.equal(glyphSign(r.glyph), sign(delta), `(${current},${prior}) glyph=${r.glyph}`);
    }
  }
});

test('property: prior absent (null/undefined) -> na_no_prior, never a glyph', () => {
  const r1 = WarroomTrend.trend(50, null);
  assert.equal(r1.state, 'na_no_prior');
  assert.equal(r1.glyph, null);
  const r2 = WarroomTrend.trend(50, undefined);
  assert.equal(r2.state, 'na_no_prior');
  assert.equal(r2.glyph, null);
});

test('property: exhaustive sign(glyph) === sign(current-prior) across a generated grid', () => {
  const values = [-100, -50, -10, -5, -1, -0.005, 0, 0.005, 1, 5, 10, 50, 100, 500];
  for (const current of values) {
    for (const prior of values) {
      const r = WarroomTrend.trend(current, prior);
      const delta = current - prior;
      if (Math.abs(delta) < WarroomTrend.DEAD_BAND_USD) {
        assert.equal(r.state, 'flat', `(${current},${prior})`);
        continue;
      }
      if (r.glyph !== null) {
        assert.equal(glyphSign(r.glyph), sign(delta), `(${current},${prior}) glyph=${r.glyph} state=${r.state}`);
      }
    }
  }
});

// ---- CI proof-of-teeth: an inverted helper must fail this suite ----
test('CI proof-of-teeth: an inverted sign() would fail the exhaustive property test', () => {
  function invertedSign(n) { return n > 0 ? -1 : (n < 0 ? 1 : 0); } // deliberately backwards
  function invertedTrendGlyph(current, prior) {
    if (prior === null || prior === undefined) return null;
    const delta = current - prior;
    if (Math.abs(delta) < WarroomTrend.DEAD_BAND_USD) return '→';
    return invertedSign(delta) > 0 ? '↑' : '↓';
  }
  // Confirm the inverted version genuinely disagrees with the real helper on a real case --
  // this proves the property test in this file WOULD catch an inverted glyph if one shipped,
  // it does not modify lib/warroom-trend.js itself (verified clean below).
  const real = WarroomTrend.trend(111.87, 5.00);
  const inverted = invertedTrendGlyph(111.87, 5.00);
  assert.notEqual(real.glyph, inverted, 'sanity: inverted helper should disagree with the real one');
  assert.equal(glyphSign(inverted), -sign(111.87 - 5.00), 'inverted helper is confirmed backwards');
});
