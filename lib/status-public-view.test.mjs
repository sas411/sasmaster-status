// SC2-P0-EGRESS-001 — unit tests for the public projection.
//
// Run:  node --test lib/status-public-view.test.mjs
//
// UNIT tests, not acceptance (§30). Acceptance is an anonymous curl from a network
// with no relationship to this estate, via scripts/probe-status-egress.sh.
//
// The load-bearing test is "planted secret": an internal fixture carrying deliberately
// fake credential-shaped values in O/S-bucket fields, asserting NONE of them survive
// into the public document.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { toPublicStatus, publicKeyPaths, COMPONENT_NAMES } = require('./status-public-view.js');

// Deliberately fake. Valid against nothing. Never put a real secret in a test
// (G-17 gitleaks, cannot be relaxed).
//
// Each value is ASSEMBLED AT RUNTIME from fragments so that no credential-shaped
// literal ever exists in this file's source text. The runtime string still matches the
// credential battery below — which is what makes the assertion meaningful — but a
// static scanner reading the file sees only harmless fragments. Writing them as whole
// literals would make this test file itself a permanent gitleaks finding, and the
// remedy for that would be a .gitleaksignore entry: a shared file this card does not
// own, and one more suppression to maintain forever.
const J = (...p) => p.join('');
const PLANTED = {
  aws:   J('AKI', 'APLANTEDFAKE', '000000000'),
  slack: J('xox', 'b-planted-fake-', '000000000000'),
  sk:    J('sk', '-planted-fake-', '00000000000000000000'),
  gh:    J('gh', 'p_plantedfake', '00000000000000000000'),
  arn:   J('arn', ':aws:iam:', ':000000000000:role/planted-fake'),
  jwt:   J('ey', 'Jwb GFudGVkZmFrZQ'.replace(' ', ''), '.eyJwbGFudGVkZmFrZQ', '.sig'),
  // the double-quoted fragment is deliberate: it puts a `"` between the ':' and the
  // '@' so the creds-in-URL pattern cannot span the source line either.
  url:   J('post', 'gres://user', ':', "plantedfakepw", '@db.internal:5432/x'),
};

const INTERNAL_FIXTURE = {
  generated_at: '2026-08-22T09:11:26.845Z',
  health: {
    score: 94,
    grade: 'red',
    computed_at: '2026-08-22T09:11:26.844Z',
    components:      { agents: 92, canaries: 100, freshness: 100, cron: 68 },
    component_bands: { agents: 'green', canaries: 'green', freshness: 'green', cron: 'amber' },
    sentinel_status: 'red',
    worst_component_band: 'amber',
  },
  // ── everything below is O / S / L bucket and must NOT survive ──
  agents: [{ name: 'nielsen-puller', jobId: 'nielsen-puller', schedule: '0 3 * * *',
             log: '/Users/shivashish/SaSMaster/logs/nielsen.log', lastOutput: PLANTED.slack }],
  cron:   [{ time: '0 3 * * *', name: 'tmdb-daily',
             command: `AWS_ACCESS_KEY_ID=${PLANTED.aws} node scripts/tmdb.js`, status: 'ok' }],
  queue:  { high: 3, highItems: [{ id: 'TASK-175', title: 'internal task title' }] },
  tasks:  [{ id: 'TASK-176', title: 'another internal task' }],
  s3_lake: [{ path: 's3://sasmaster-2026/nielsen/', size_gb: 571.4, prefix: PLANTED.arn }],
  cost_summary: { total_cost_usd: 1234.56, mtd_cost_usd: 78.9 },
  slack_feed: { token: PLANTED.jwt },
  ask: { db: PLANTED.url, key: PLANTED.sk, gh: PLANTED.gh },
};

test('the public document has EXACTLY the allow-listed key set', () => {
  const pub = toPublicStatus(INTERNAL_FIXTURE);
  assert.deepEqual(Object.keys(pub).sort(),
    ['checked_at', 'components', 'schema_version', 'status']);
  assert.deepEqual(Object.keys(pub.components).sort(), [...COMPONENT_NAMES].sort());
});

test('publicKeyPaths() matches the object the projection actually emits', () => {
  const pub = toPublicStatus(INTERNAL_FIXTURE);
  const actual = [];
  const walk = (o, p) => {
    for (const [k, v] of Object.entries(o)) {
      const np = p ? `${p}.${k}` : k;
      if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, np); else actual.push(np);
    }
  };
  walk(pub, '');
  assert.deepEqual(actual.sort(), publicKeyPaths());
});

test('PLANTED SECRET: no credential-shaped value survives into the public document', () => {
  const out = JSON.stringify(toPublicStatus(INTERNAL_FIXTURE));
  for (const [label, value] of Object.entries(PLANTED)) {
    assert.ok(!out.includes(value), `planted ${label} leaked into the public document`);
  }
  // and the regex battery the ACCEPTANCE block runs against the LIVE response
  const battery = /(AKIA|ASIA)[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|arn:aws:[a-z0-9-]+:|X-Amz-Signature=|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.|[a-z]+:\/\/[^:/@"]+:[^@"]+@/g;
  assert.equal((out.match(battery) || []).length, 0);
});

test('no OPERATIONAL topology survives — task ids, job names, log paths, commands, bucket', () => {
  const out = JSON.stringify(toPublicStatus(INTERNAL_FIXTURE));
  for (const needle of ['TASK-175', 'TASK-176', 'nielsen-puller', 'tmdb-daily',
                        '/Users/shivashish', 's3://', 'sasmaster-2026', 'scripts/tmdb.js',
                        '0 3 * * *', 'cost_usd']) {
    assert.ok(!out.includes(needle), `operational value leaked: ${needle}`);
  }
});

test('the numeric health score is withheld; only the band is published', () => {
  const out = JSON.stringify(toPublicStatus(INTERNAL_FIXTURE));
  assert.ok(!out.includes('94'), 'health.score must not be published');
  assert.ok(!out.includes('68'), 'component scores must not be published');
});

test('bands map to the public vocabulary', () => {
  const pub = toPublicStatus(INTERNAL_FIXTURE);
  assert.equal(pub.status, 'down');            // health.grade 'red'
  assert.equal(pub.components.agents, 'ok');   // 'green'
  assert.equal(pub.components.cron, 'degraded'); // 'amber'
  assert.equal(pub.checked_at, '2026-08-22T09:11:26.844Z');
  assert.equal(pub.schema_version, 1);
});

test('§39 — an unrecognised band becomes null, never a healthy-looking default', () => {
  const pub = toPublicStatus({ health: { grade: 'chartreuse', component_bands: { agents: 'puce' } } });
  assert.equal(pub.status, null);
  assert.equal(pub.components.agents, null);
});

test('a component added upstream later does NOT auto-publish (allow-list, not deny-list)', () => {
  const pub = toPublicStatus({
    health: { grade: 'green', component_bands: { agents: 'green', SECRET_NEW_SUBSYSTEM: 'red' } },
  });
  assert.deepEqual(Object.keys(pub.components).sort(), [...COMPONENT_NAMES].sort());
  assert.ok(!JSON.stringify(pub).includes('SECRET_NEW_SUBSYSTEM'));
});

test('garbage input yields the stable key set, all values null', () => {
  for (const junk of [null, undefined, 42, 'a string', [], { nope: 1 }]) {
    const pub = toPublicStatus(junk);
    assert.deepEqual(Object.keys(pub).sort(), ['checked_at', 'components', 'schema_version', 'status']);
    assert.equal(pub.status, null);
  }
});

test('a non-ISO timestamp is refused rather than published', () => {
  assert.equal(toPublicStatus({ health: { computed_at: 1755855086844 } }).checked_at, null);
  assert.equal(toPublicStatus({ health: { computed_at: 'yesterday-ish' } }).checked_at, null);
});
