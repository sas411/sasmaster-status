// WARROOM-CONTRACT-CI-001 — unit tests for the contract gate's pure check functions.
// Mirrors this repo's existing pattern (test/warroom-clock.test.mjs, test/warroom-trend.test.mjs):
// node:test, no external test framework. Writes small temp fixture files under os.tmpdir()
// (never inside the repo — same discipline as the Phase-6 scratch fixture) and scans them
// via the module's exported check functions directly (no CLI spawn needed for these).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const gate = require('../scripts/warroom-contract-gate.js');

function tmpFile(content) {
  const p = path.join(os.tmpdir(), `wcg-test-${process.pid}-${Math.random().toString(36).slice(2)}.js`);
  fs.writeFileSync(p, content);
  return p;
}

test('check_no_bare_emdash: ternary fallback to bare em-dash is flagged, with a file:line', () => {
  const f = tmpFile("function x(v){ return v!=null ? v : '—'; }\n");
  const v = gate.check_no_bare_emdash([f]);
  assert.equal(v.length, 1);
  assert.equal(v[0].contract, 'C2');
  assert.equal(v[0].line, 1);
  fs.unlinkSync(f);
});

test('check_no_bare_emdash: ordinary string content is not flagged (no false positive)', () => {
  const f = tmpFile("const label = 'Agents — Data Pipeline';\n"); // prose em-dash, not a value-slot fallback
  const v = gate.check_no_bare_emdash([f]);
  assert.equal(v.length, 0);
  fs.unlinkSync(f);
});

test('check_no_status_literal: HEALTHY literal outside the health module is flagged', () => {
  const f = tmpFile("el.textContent = 'HEALTHY';\n");
  const v = gate.check_no_status_literal([f], []);
  assert.equal(v.length, 1);
  assert.equal(v[0].contract, 'C3');
  fs.unlinkSync(f);
});

test('check_no_status_literal: the health module file itself is exempt by design', () => {
  const v = gate.check_no_status_literal([gate.HEALTH_MODULE_FILE], []);
  assert.equal(v.length, 0);
});

test('check_no_status_literal: lowercase internal state code "ok" is NOT flagged (case-sensitive OK)', () => {
  const f = tmpFile("const dot = f => f.status==='ok' ? 1 : 0;\n");
  const v = gate.check_no_status_literal([f], []);
  assert.equal(v.length, 0);
  fs.unlinkSync(f);
});

test('check_one_clock: ambient toLocaleTimeString() outside WarroomClock is flagged', () => {
  const f = tmpFile("function t(){ return new Date().toLocaleTimeString(); }\n");
  const v = gate.check_one_clock([f], { includeBareNewDate: false });
  assert.ok(v.some((x) => /toLocaleTimeString/.test(x.message)));
  fs.unlinkSync(f);
});

test('check_one_clock: bare new Date() flagged only when includeBareNewDate is true', () => {
  const f = tmpFile("const now = new Date();\n");
  const off = gate.check_one_clock([f], { includeBareNewDate: false });
  const on = gate.check_one_clock([f], { includeBareNewDate: true });
  assert.equal(off.length, 0);
  assert.equal(on.length, 1);
  fs.unlinkSync(f);
});

test('check_one_clock: the clock module file itself is exempt by design', () => {
  const v = gate.check_one_clock([gate.CLOCK_MODULE_FILE], { includeBareNewDate: true });
  assert.equal(v.length, 0);
});

test('check_trend_glyph_sign: reuses WarroomTrend.trend() and catches a sign contradiction', () => {
  const f = tmpFile('const row = \'<tr><td class="mono">Anthropic API</td><td class="mono">$0.00</td><td class="mono">$0.00</td><td class="mono">↓</td></tr>\';\n');
  const v = gate.check_trend_glyph_sign([f]);
  assert.ok(v.some((x) => /sign contradiction/.test(x.message)));
  assert.ok(v.some((x) => /assigned as a literal/.test(x.message)));
  fs.unlinkSync(f);
});

test('check_trend_glyph_sign: a row whose glyph agrees with WarroomTrend.trend() is not flagged for sign (still flagged as a literal)', () => {
  const f = tmpFile('const row = \'<tr><td class="mono">AWS</td><td class="mono">$5.00</td><td class="mono">$5.00</td><td class="mono">→</td></tr>\';\n');
  const v = gate.check_trend_glyph_sign([f]);
  assert.ok(!v.some((x) => /sign contradiction/.test(x.message)));
  assert.ok(v.some((x) => /assigned as a literal/.test(x.message)));
  fs.unlinkSync(f);
});

test('check_one_source_per_number: two distinct patterns for the same registered figure are flagged', () => {
  const f = tmpFile('const a = usageState.cache_hit_rate_pct;\nconst b = d.cache_hit_rate;\n');
  const result = gate.check_one_source_per_number([f]);
  assert.ok(result.violations.some((v) => /cache_hit_rate/.test(v.message)));
  fs.unlinkSync(f);
});

test('check_one_source_per_number: a single-source figure is not flagged', () => {
  const f = tmpFile('const a = d.avg_input_tokens;\n');
  const result = gate.check_one_source_per_number([f]);
  assert.equal(result.violations.length, 0);
  fs.unlinkSync(f);
});

test('exemption: a live (non-expired) CONTRACT-EXEMPT suppresses the flagged line', () => {
  const f = tmpFile("el.textContent = 'HEALTHY'; // CONTRACT-EXEMPT: C3 — test — 2099-01-01\n");
  const v = gate.check_no_status_literal([f], []);
  assert.equal(v.length, 0);
  fs.unlinkSync(f);
});

test('exemption: an EXPIRED CONTRACT-EXEMPT does not suppress, and is reported expired', () => {
  const f = tmpFile("el.textContent = 'HEALTHY'; // CONTRACT-EXEMPT: C3 — test — 2020-01-01\n");
  const v = gate.check_no_status_literal([f], []);
  assert.equal(v.length, 1); // still fails
  const ledger = gate.findExemptionsInFiles([f]);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].expired, true);
  fs.unlinkSync(f);
});

test('WARROOM_ALLOWED_SITES.yml parses as an empty list today (Phase 0 DoD)', () => {
  const sites = gate.parseAllowedSites();
  assert.deepEqual(sites, []);
});

test('CLI --files mode: the seeded 6-violation fixture fails with the right file:lines (proof of teeth)', async () => {
  const content = [
    "function fallback(x){ return x != null ? x : '—'; }",
    "function badge(el){ el.textContent = 'HEALTHY'; }",
    "function nowLabel(){ return new Date().toLocaleTimeString(); }",
    'const cacheHitFromSnapshot = usageState.cache_hit_rate_pct;',
    'const cacheHitFromCostLog = d.cache_hit_rate;',
    'const row = \'<tr><td class="mono">Anthropic API</td><td class="mono">$0.00</td><td class="mono">$0.00</td><td class="mono">↓</td></tr>\';',
    '',
  ].join('\n');
  const f = tmpFile(content);
  const result = await gate.runGate(['--files', f, '--json']);
  assert.equal(result.exit, 1);
  const byCheck = Object.fromEntries(result.report.map((r) => [r.check, r]));
  assert.ok(byCheck.C2.count >= 1, 'C2 should fire');
  assert.ok(byCheck.C3.count >= 1, 'C3 should fire');
  assert.ok(byCheck.C5.count >= 1, 'C5 should fire');
  assert.ok(byCheck.C6.count >= 1, 'C6 should fire');
  assert.ok(byCheck['trend-glyph'].count >= 1, 'trend-glyph should fire');
  fs.unlinkSync(f);
});
