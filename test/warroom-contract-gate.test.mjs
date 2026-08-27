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

function tmpFileExt(content, ext) {
  const p = path.join(os.tmpdir(), `wcg-test-${process.pid}-${Math.random().toString(36).slice(2)}.${ext}`);
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

// ---------------------------------------------------------------------------------------
// CORRECTION (08-27): C2/C3/C6 (and, verified independently, C5 and trend-glyph) originally
// regex-matched RAW source text including comments — this is the false-positive class
// documented in DONE_LOG.md's C6 "cache_hit_rate dual-source" CORRECTION note (a comment
// describing a fix, mentioning the old removed pattern by name, was counted as a live read).
// These tests reproduce that exact class and prove the fix: a comment naming the banned
// pattern is NOT flagged, while a real (non-comment) violation on another line still is.
// ---------------------------------------------------------------------------------------

test('check_no_bare_emdash: a comment describing the bare em-dash bug is not flagged, real code still is', () => {
  const f = tmpFile([
    "// old code used to do: v != null ? v : '—'  -- fixed below, do not reintroduce",
    "function fallback(v){ return v != null ? v : '—'; }",
    '',
  ].join('\n'));
  const v = gate.check_no_bare_emdash([f]);
  assert.equal(v.length, 1);
  assert.equal(v[0].line, 2);
  fs.unlinkSync(f);
});

test('check_no_status_literal: a comment mentioning HEALTHY is not flagged, real code still is', () => {
  const f = tmpFile([
    "// this badge used to hardcode 'HEALTHY' before routing through WarroomHealth — do not revert",
    "el.textContent = 'HEALTHY';",
    '',
  ].join('\n'));
  const v = gate.check_no_status_literal([f], []);
  assert.equal(v.length, 1);
  assert.equal(v[0].line, 2);
  fs.unlinkSync(f);
});

test('check_one_source_per_number: a comment naming the old cache_hit_rate_pct path is not counted as a live source (the exact CORRECTION-note false positive)', () => {
  const f = tmpFile([
    '// NOTE: this used to read usageState.cache_hit_rate_pct before COSTCANON-001 Phase 3 removed it',
    'function renderCache(d){ return d.cache_hit_rate; }',
    '',
  ].join('\n'));
  const result = gate.check_one_source_per_number([f]);
  assert.equal(result.violations.length, 0); // only ONE live pattern (cost-log-real); comment must not count as a second source
  fs.unlinkSync(f);
});

test('check_one_source_per_number: real (non-comment) code for both patterns is still flagged', () => {
  const f = tmpFile([
    '// (this comment mentions cache_hit_rate_pct too — must not change the count below)',
    'const a = usageState.cache_hit_rate_pct;',
    'const b = d.cache_hit_rate;',
    '',
  ].join('\n'));
  const result = gate.check_one_source_per_number([f]);
  assert.ok(result.violations.some((v) => /cache_hit_rate/.test(v.message)));
  fs.unlinkSync(f);
});

test('check_one_clock: a comment mentioning toLocaleTimeString() is not flagged, real code still is', () => {
  const f = tmpFile([
    '// this used to call .toLocaleTimeString() directly before the fix',
    'function t(){ return new Date().toLocaleTimeString(); }',
    '',
  ].join('\n'));
  const v = gate.check_one_clock([f], { includeBareNewDate: false });
  assert.equal(v.length, 1);
  assert.equal(v[0].line, 2);
  fs.unlinkSync(f);
});

test('check_trend_glyph_sign: a comment mentioning a glyph literal is not flagged (structural check)', () => {
  const f = tmpFile([
    '// example glyph shown in the old markup: >↑<',
    'const x = 1;',
    '',
  ].join('\n'));
  const v = gate.check_trend_glyph_sign([f]);
  assert.equal(v.length, 0);
  fs.unlinkSync(f);
});

test('comment-stripping: "//" inside a string literal (e.g. a URL) is not treated as a comment start', () => {
  const f = tmpFile("const url = 'https://example.com'; el.textContent = 'HEALTHY';\n");
  const v = gate.check_no_status_literal([f], []);
  assert.equal(v.length, 1); // HEALTHY still flagged — the URL's "//" must not swallow the rest of the line
  fs.unlinkSync(f);
});

test('comment-stripping: /* */ block comment spanning lines does not shift line numbers', () => {
  const f = tmpFile([
    '/* this is a stale block comment',
    '   mentioning HEALTHY across multiple lines',
    '   should not be flagged */',
    "el.textContent = 'HEALTHY';",
    '',
  ].join('\n'));
  const v = gate.check_no_status_literal([f], []);
  assert.equal(v.length, 1);
  assert.equal(v[0].line, 4); // real violation's line number must survive the multi-line strip
  fs.unlinkSync(f);
});

test('comment-stripping: a quoted status literal inside an HTML <!-- --> comment is not flagged, a real one in <script> still is', () => {
  const f = tmpFileExt([
    "<!-- the badge used to say 'HEALTHY' directly before routing through WarroomHealth -->",
    '<script>',
    "el.textContent = 'HEALTHY';",
    '</script>',
    '',
  ].join('\n'), 'html');
  const v = gate.check_no_status_literal([f], []);
  assert.equal(v.length, 1);
  assert.equal(v[0].line, 3);
  fs.unlinkSync(f);
});

test('WARROOM_ALLOWED_SITES.yml parses to well-formed entries (shape, not emptiness)', () => {
  // Was: assert.deepEqual(sites, []) — a "Phase 0 DoD" snapshot that hard-asserted the live
  // repo file stays empty forever. The file's own header says the opposite is the design:
  // "Each future Phase 1/2 card that needs a site here adds its own entry as part of its own
  // DoD." WARROOM-NOWPLANE-001 did exactly that (now-plane-chip-state-map) in the same commit
  // this test landed in, so the old assertion was never green on main — it fought the file it
  // was reading. Replaced with a shape check: whatever entries exist (zero or more) must carry
  // the required fields the header documents, so drift in the YAML's structure still fails loud.
  const sites = gate.parseAllowedSites();
  assert.ok(Array.isArray(sites));
  const REQUIRED_FIELDS = ['id', 'file', 'contract', 'reason', 'registered_by', 'expiry'];
  for (const site of sites) {
    for (const field of REQUIRED_FIELDS) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(site, field) && site[field],
        `WARROOM_ALLOWED_SITES.yml entry '${site.id || '(no id)'}' missing required field '${field}'`
      );
    }
    assert.match(site.expiry, /^\d{4}-\d{2}-\d{2}$/, `entry '${site.id}' expiry must be ISO YYYY-MM-DD`);
  }
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
