// SC2-P0-SSRF-001 — unit tests for the /api/ask admission contract.
//
// Run:  node --test test/ask-guard.test.mjs
//
// These are UNIT tests. They are NOT acceptance (§30): acceptance is adversarial HTTP
// against the deployed public origin, run by an agent other than the builder, using
// scripts/probe-ask-guard.sh. Both are required; only the probe is acceptance.
//
// Console noise is expected — every rejection logs at WARN by design (§41). The
// "logs what it drops" behaviour is itself asserted below.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ask = require('../api/ask.js');

const { _admitPath: admitPath, _applyCors: applyCors } = ask;

const GOOD_ORIGIN = 'https://sasmaster-status.vercel.app';

function mkRes() {
  const headers = {};
  return {
    headers,
    setHeader(k, v) { headers[k.toLowerCase()] = v; },
    get(k) { return headers[k.toLowerCase()]; },
  };
}

// ── Gate 2/3/4/5 — path admission ────────────────────────────────────────────────

test('accepts the default path when ?path is absent', () => {
  const v = admitPath(undefined, 'POST');
  assert.equal(v.ok, true);
  assert.equal(v.pathname, '/ask');
});

test('accepts an explicit /ask on POST', () => {
  assert.equal(admitPath('/ask', 'POST').ok, true);
});

test('REJECTS an absolute URL — new URL ignores the base', () => {
  const v = admitPath('https://example.com/', 'POST');
  assert.equal(v.ok, false);
  assert.equal(v.status, 400);
  assert.equal(v.error, 'invalid_path');
});

test('REJECTS a protocol-relative //host — scheme inherited, host attacker-chosen', () => {
  const v = admitPath('//example.com/', 'POST');
  assert.equal(v.ok, false);
  assert.equal(v.status, 400);
});

test('REJECTS a backslash variant /\\host', () => {
  const v = admitPath('/\\example.com/', 'POST');
  assert.equal(v.ok, false);
  assert.equal(v.status, 400);
});

test('REJECTS a bare slash — nothing to proxy', () => {
  assert.equal(admitPath('/', 'POST').status, 400);
});

test('REJECTS a path with no leading slash', () => {
  assert.equal(admitPath('ask', 'POST').status, 400);
});

test('REJECTS an ARRAY-valued path (repeated ?path= query param)', () => {
  const v = admitPath(['/ask', 'https://example.com/'], 'POST');
  assert.equal(v.ok, false);
  assert.equal(v.status, 400);
  assert.equal(v.error, 'invalid_path');
});

test('REJECTS a non-string, non-array path', () => {
  assert.equal(admitPath({ toString: () => '/ask' }, 'POST').status, 400);
});

test('REJECTS an on-origin path that is NOT on the policy (deny by default)', () => {
  // /health IS a real Railway route and resolves to the Railway origin — it passes
  // gates 2 and 3. It is refused at gate 4 because nothing calls it through this proxy.
  const v = admitPath('/health', 'GET');
  assert.equal(v.ok, false);
  assert.equal(v.status, 400);
});

test('REJECTS the presign minter specifically', () => {
  assert.equal(admitPath('/api/v1/s3/presign', 'GET').ok, false);
});

test('dot-segments cannot escape the origin — the invariant covers them', () => {
  // new URL normalises /../ ON THE SAME ORIGIN, so this lands on /x, which is simply
  // not on the policy. It never reaches an attacker host.
  const v = admitPath('/../../x', 'POST');
  assert.equal(v.ok, false);
});

test('GET on /ask is refused by METHOD admission, not by the path gate', () => {
  const v = admitPath('/ask', 'GET');
  assert.equal(v.ok, false);
  assert.equal(v.status, 405);
  assert.equal(v.error, 'method_not_allowed');
});

test('a query string on an admitted path survives', () => {
  const v = admitPath('/ask?trace=1', 'POST');
  assert.equal(v.ok, true);
  assert.equal(v.pathname, '/ask');
  assert.equal(v.search, '?trace=1');
});

// ── Gate 1 — CORS ────────────────────────────────────────────────────────────────

test('allows the production origin and echoes it back exactly', () => {
  const res = mkRes();
  assert.equal(applyCors({ headers: { origin: GOOD_ORIGIN } }, res), true);
  assert.equal(res.get('access-control-allow-origin'), GOOD_ORIGIN);
});

test('DENIES an absent Origin — the bypass this card exists to delete', () => {
  const res = mkRes();
  assert.equal(applyCors({ headers: {} }, res), false);
  assert.equal(res.get('access-control-allow-origin'), undefined);
});

test('DENIES an unknown Origin and never reflects it', () => {
  const res = mkRes();
  assert.equal(applyCors({ headers: { origin: 'https://evil.example' } }, res), false);
  assert.equal(res.get('access-control-allow-origin'), undefined);
});

test('DENIES the suffix-match trap (catches .includes/.endsWith allowlists)', () => {
  const res = mkRes();
  const trap = 'https://sasmaster-status.vercel.app.evil.com';
  assert.equal(applyCors({ headers: { origin: trap } }, res), false);
  assert.equal(res.get('access-control-allow-origin'), undefined);
});

test('DENIES a prefix-match trap', () => {
  const res = mkRes();
  assert.equal(applyCors({ headers: { origin: 'https://evil.com/https://sasmaster-status.vercel.app' } }, res), false);
});

test('Vary: Origin is set on EVERY path, allowed and denied', () => {
  const allowed = mkRes();
  applyCors({ headers: { origin: GOOD_ORIGIN } }, allowed);
  assert.equal(allowed.get('vary'), 'Origin');

  const denied = mkRes();
  applyCors({ headers: {} }, denied);
  assert.equal(denied.get('vary'), 'Origin');
});

test('the allow-list contains no wildcard and no empty entry', () => {
  for (const o of ask._ALLOWED_ORIGINS) {
    assert.match(o, /^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/, `bad allow-list entry shape: ${o.length} chars`);
  }
});

// ── §41 — the gate logs what it drops ─────────────────────────────────────────────

test('every rejection emits exactly one WARN line, and it leaks no input value', () => {
  const seen = [];
  const original = console.warn;
  console.warn = (...a) => seen.push(a.map(String).join(' '));
  try {
    admitPath('https://evil.example/steal', 'POST');   // path reject
    admitPath('/ask', 'GET');                          // method reject
    applyCors({ headers: { origin: 'https://evil.example' } }, mkRes()); // origin reject
  } finally {
    console.warn = original;
  }

  assert.equal(seen.length, 3, 'each drop logs exactly once');
  for (const line of seen) {
    assert.match(line, /ask-guard/, 'log line names the gate');
    assert.match(line, /dropped/, 'log line states the disposition');
    assert.ok(!line.includes('evil.example'), 'attacker-supplied value must never reach the log');
    assert.ok(!line.includes('steal'), 'attacker-supplied value must never reach the log');
  }
});

test('a clean pass logs NOTHING (a gate that always reports drops is also broken)', () => {
  const seen = [];
  const original = console.warn;
  console.warn = (...a) => seen.push(a.join(' '));
  try {
    admitPath('/ask', 'POST');
    applyCors({ headers: { origin: GOOD_ORIGIN } }, mkRes());
  } finally {
    console.warn = original;
  }
  assert.equal(seen.length, 0);
});

// ── The credential is never attachable off-origin ─────────────────────────────────

test('no admitted path can resolve off the Railway origin', () => {
  const base = process.env.ASK_RAILWAY_URL || 'https://sasmaster-ask-production.up.railway.app';
  const expected = new URL(base).origin;
  const attempts = [
    'https://example.com/', '//example.com/', '/\\example.com/', 'ask', '/',
    '/../../../example.com', '/ask/../../x', 'HTTPS://example.com/', '/%2f%2fexample.com/',
    'https:/example.com', '/ask#@example.com', '\\\\example.com',
  ];
  for (const a of attempts) {
    const v = admitPath(a, 'POST');
    if (v.ok) {
      assert.equal(new URL(v.pathname, base).origin, expected, `admitted path escaped origin: len=${a.length}`);
    }
  }
});
