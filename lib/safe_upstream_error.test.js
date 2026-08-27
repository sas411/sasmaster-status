'use strict';
/**
 * safe_upstream_error.test.js — SC2-P0-AWSKEY-001 Track B acceptance tests.
 *
 * Zero dependencies, zero network, zero AWS.  Run:
 *
 *     cd sasmaster-status && node lib/safe_upstream_error.test.js
 *
 * FINDING, recorded rather than worked around (§01 3.4): the card's ACCEPTANCE
 * says `npm test -- safe_upstream_error`.  `sasmaster-status/package.json` has
 * NO `test` script and NO test framework in dependencies or devDependencies
 * (verified 2026-08-22), and `package.json` is not owned by this card (§23), so
 * it was not edited.  The one-line patch fragment is in the close-out for the
 * orchestrator; until it is applied, the command above is the runnable form.
 *
 * §6.6 — every rule this card introduces ships with the check that goes RED when
 * the rule is violated, proven RED on a deliberately violating input.  See
 * `forced-failure drill` at the bottom: it runs the leak invariant against a
 * sanitizer that leaks, and requires the invariant to FAIL.
 */

const assert = require('assert');
const S = require('./safe_upstream_error');

/** The exact string observed leaking from GET /api/costs on 2026-08-18. */
const LEAKED = 'The AWS Access Key Id you provided does not exist in our records.';

/** The card's ACCEPTANCE grep, as a regex. */
const FORBIDDEN_RE = /aws|akia|iam|signature|token/i;

/** A faithful @aws-sdk/client-s3 v3 error object for an unknown key id. */
function s3InvalidAccessKeyId() {
  const err = new Error(LEAKED);
  err.name = 'InvalidAccessKeyId';
  err.Code = 'InvalidAccessKeyId';
  err.$fault = 'client';
  err.$metadata = {
    httpStatusCode: 403,
    requestId: 'ZX9Q2K4M7N1P0R3T',
    extendedRequestId: 'aB3dEf5GhI7jKl9MnO1pQr3StU5vWx7Y',
    attempts: 1,
    totalRetryDelay: 0,
  };
  err.AWSAccessKeyId = 'AKIAIOSFODNN7EXAMPLE';
  return err;
}

// ── invariant helpers ─────────────────────────────────────────────────────────

/**
 * Every string/number reachable from `err`, plus every property NAME.
 *
 * Names are collected too: a key called `awsSecretAccessKey` is disclosure even
 * when its value is short.  Names that collide with the envelope's own
 * structural keys (`error`, `code`, `message`, `upstream`, `ref`) are excluded —
 * `Error.prototype.message` is a JS property name, not a fact about our estate,
 * and including it would make the sweep fire on the envelope's own schema.
 */
const ENVELOPE_KEYS = new Set(['error', 'code', 'message', 'upstream', 'ref']);

function reachableValues(err) {
  const seen = new Set();
  const out = [];
  (function walk(v) {
    if (v === null || v === undefined) return;
    if (typeof v === 'string' || typeof v === 'number') { out.push(String(v)); return; }
    if (typeof v !== 'object' && typeof v !== 'function') return;
    if (seen.has(v)) return;
    seen.add(v);
    let names = [];
    try { names = Object.getOwnPropertyNames(v); } catch (_) { return; }
    for (const k of names) {
      if (!ENVELOPE_KEYS.has(k)) out.push(k);
      let child;
      try { child = v[k]; } catch (_) { continue; }
      walk(child);
    }
  })(err);
  return out;
}

/**
 * THE HARD RULE: no value reachable from `err` appears anywhere in `body`.
 *
 * Two independent proofs, because one of them is probabilistic:
 *   (a) STRUCTURAL — airtight.  `body` has exactly the allowed keys and every
 *       value is from the module's closed vocabulary, is the neutral/allowed
 *       public label, or matches the ref format.  Nothing else can be present.
 *   (b) SWEEP — defence in depth.  No err-reachable token of length >= 4 occurs
 *       in JSON.stringify(body).  Length 4 because shorter fragments collide by
 *       chance with structural text and carry no disclosure on their own; (a) is
 *       what actually rules those out.
 */
function assertNoErrValueInBody(err, body, allowedLabels) {
  // (a) structural
  assert.deepStrictEqual(Object.keys(body), ['error'], 'body has unexpected top-level keys');
  assert.deepStrictEqual(Object.keys(body.error).sort(),
    ['code', 'message', 'ref', 'upstream'], 'body.error has unexpected keys');
  const codes = Object.values(S.CODES);
  assert.ok(codes.includes(body.error.code), `code not in vocabulary: ${body.error.code}`);
  const allowedMessages = Object.values(S.MESSAGES);
  assert.ok(allowedMessages.includes(body.error.message)
    || (allowedLabels && allowedLabels.messages
        && allowedLabels.messages.includes(body.error.message)),
    `message not in vocabulary: ${body.error.message}`);
  assert.ok(S.REF_RE.test(body.error.ref), `ref malformed: ${body.error.ref}`);
  const okLabels = (allowedLabels && allowedLabels.labels) || [S.NEUTRAL_LABEL];
  assert.ok(okLabels.includes(body.error.upstream),
    `upstream label not allowed: ${body.error.upstream}`);

  // (b) sweep
  const blob = JSON.stringify(body);
  for (const v of reachableValues(err)) {
    if (v.length < 4) continue;
    assert.ok(!blob.includes(v),
      `err-reachable value leaked into body: ${JSON.stringify(v.slice(0, 80))}`);
  }
}

// ── tests ─────────────────────────────────────────────────────────────────────

const tests = {};

tests['the literal leaked string is absent from the body'] = () => {
  const err = s3InvalidAccessKeyId();
  const { status, body, log } = S.sanitize(err, {
    upstream: 'aws_s3', publicLabel: 'cost_metrics',
    publicMessage: 'Cost data is temporarily unavailable.', refPrefix: 'cst',
  });
  const blob = JSON.stringify(body);
  assert.ok(!blob.includes(LEAKED), 'THE leaked sentence is still in the body');
  assert.ok(!blob.includes('does not exist in our records'), blob);
  assert.ok(!blob.includes('AKIAIOSFODNN7EXAMPLE'), blob);
  assert.strictEqual(status, 503);
  // §41 — and it IS in the log, under the same ref.
  assert.strictEqual(log.provider_message, LEAKED,
    'the suppressed provider string must be retained server-side');
  assert.strictEqual(log.ref, body.error.ref, 'log and body must share the ref');
  assert.strictEqual(log.upstream, 'aws_s3', 'the precise upstream belongs in the log');
};

tests['ACCEPTANCE grep: body has zero matches for aws|akia|iam|signature|token'] = () => {
  for (const err of [s3InvalidAccessKeyId(), sigMismatch(), noCreds(), timeout(),
                     noSuchKey(), plainError(), null, undefined, 'a string', 42]) {
    const { body } = S.sanitize(err, {
      upstream: 'aws_s3', publicLabel: 'cost_metrics',
      publicMessage: 'Cost data is temporarily unavailable.', refPrefix: 'cst',
    });
    const blob = JSON.stringify(body);
    assert.ok(!FORBIDDEN_RE.test(blob),
      `body matched the forbidden pattern: ${blob}`);
  }
};

tests['the provider label CANNOT be leaked, even when passed deliberately'] = () => {
  // §53 — this is the interlock, not a convention. The card's own interface
  // contract would have published "aws_cost_explorer"; the module refuses it.
  for (const attempt of ['aws_cost_explorer', 'AWS_S3', 'amazon', 'iam', 'sts',
                         'motherduck', 'my_secret_key', 'arn_thing', '../../etc']) {
    const { body, log } = S.sanitize(s3InvalidAccessKeyId(), {
      upstream: 'aws_s3', publicLabel: attempt, refPrefix: 'cst',
    });
    assert.strictEqual(body.error.upstream, S.NEUTRAL_LABEL,
      `label "${attempt}" reached the public body`);
    assert.strictEqual(log.public_label_refused, attempt,
      `refusal of "${attempt}" was not logged (§41)`);
    assert.ok(!FORBIDDEN_RE.test(JSON.stringify(body)), JSON.stringify(body));
  }
};

tests['the public message cannot be used as a leak channel either'] = () => {
  const { body } = S.sanitize(s3InvalidAccessKeyId(), {
    upstream: 'aws_s3', publicLabel: 'cost_metrics', publicMessage: LEAKED,
  });
  assert.ok(!JSON.stringify(body).includes('does not exist'), JSON.stringify(body));
  assert.ok(Object.values(S.MESSAGES).includes(body.error.message), body.error.message);
};

tests['classification is by structured fields, never by message text'] = () => {
  // Same prose, no structured fields at all => must NOT be classified as
  // unauthorized. Matching on provider prose is the anti-pattern.
  const prose = new Error(LEAKED);
  assert.strictEqual(S.classify(prose), S.CODES.INTERNAL,
    'classified off the message text — provider prose is not an API');

  // Structured field present, message empty => correctly unauthorized.
  const structured = new Error('');
  structured.name = 'InvalidAccessKeyId';
  assert.strictEqual(S.classify(structured), S.CODES.UNAUTHORIZED);
};

tests['the S3 credential family maps to upstream_unauthorized (§34 correction)'] = () => {
  // The card's table omitted InvalidAccessKeyId — the ONE error actually
  // observed in production. Without it, the live failure fell to internal/500.
  for (const name of ['InvalidAccessKeyId', 'SignatureDoesNotMatch', 'AccessDenied',
                      'ExpiredToken', 'InvalidClientTokenId', 'UnrecognizedClientException']) {
    const e = new Error('x'); e.name = name;
    assert.strictEqual(S.classify(e), S.CODES.UNAUTHORIZED, name);
    assert.strictEqual(S.sanitize(e, {}).status, 503, name);
  }
};

tests['missing credentials map to not_configured, not unauthorized'] = () => {
  const e = noCreds();
  assert.strictEqual(S.classify(e), S.CODES.NOT_CONFIGURED);
  assert.strictEqual(S.sanitize(e, {}).status, 503);
};

tests['transient and missing-artifact failures map to upstream_unavailable'] = () => {
  for (const e of [timeout(), noSuchKey(), throttled(), http500(), econnreset()]) {
    assert.strictEqual(S.classify(e), S.CODES.UNAVAILABLE,
      `${e && e.name}/${e && e.code}`);
    assert.strictEqual(S.sanitize(e, {}).status, 503);
  }
};

tests['anything unrecognised is internal/500, and still discloses nothing'] = () => {
  const { status, body } = S.sanitize(plainError(), { upstream: 'aws_s3' });
  assert.strictEqual(status, 500);
  assert.strictEqual(body.error.code, S.CODES.INTERNAL);
  assert.ok(!JSON.stringify(body).includes('kaboom'), JSON.stringify(body));
};

tests['sanitize never throws, on any input shape'] = () => {
  const weird = { get name() { throw new Error('boom'); } };
  const circular = { name: 'TimeoutError' }; circular.self = circular;
  const shapes = [['null', null], ['undefined', undefined], ['0', 0], ["''", ''],
                  ["'str'", 'str'], ['[]', []], ['{}', {}], ['Error', new Error()],
                  ['circular', circular], ['nullProto', Object.create(null)],
                  ['Symbol', Symbol('s')], ['fn', () => {}]];
  for (const [label, e] of shapes) {
    const r = S.sanitize(e, { upstream: 'aws_s3', publicLabel: 'cost_metrics' });
    assert.ok(r && r.body && r.body.error && r.body.error.ref, label);
    assert.ok([500, 503].includes(r.status), label);
    assert.ok(!FORBIDDEN_RE.test(JSON.stringify(r.body)), label);
  }
  // A getter that throws must not take the handler down with it.
  assert.doesNotThrow(() => S.sanitize(weird, {}));
  assert.doesNotThrow(() => S.sanitize(circular, {}));
};

tests['THE HARD RULE: no err-reachable value appears in the body'] = () => {
  const allowed = {
    labels: ['cost_metrics', S.NEUTRAL_LABEL],
    messages: ['Cost data is temporarily unavailable.'],
  };
  for (const err of [s3InvalidAccessKeyId(), sigMismatch(), noCreds(), timeout(),
                     noSuchKey(), throttled(), http500(), econnreset(), plainError()]) {
    const { body } = S.sanitize(err, {
      upstream: 'aws_s3', publicLabel: 'cost_metrics',
      publicMessage: 'Cost data is temporarily unavailable.', refPrefix: 'cst',
    });
    assertNoErrValueInBody(err, body, allowed);
  }
};

tests['refs are unique, well-formed and hex-only (so they cannot spell a secret)'] = () => {
  const seen = new Set();
  for (let i = 0; i < 2000; i++) {
    const ref = S.makeRef('cst');
    assert.ok(S.REF_RE.test(ref), ref);
    assert.ok(!FORBIDDEN_RE.test(ref), ref);
    seen.add(ref);
  }
  assert.strictEqual(seen.size, 2000, 'ref collision in 2000 draws');
};

tests['FORCED-FAILURE DRILL: the leak invariant goes RED on a leaking sanitizer'] = () => {
  // A check that has never failed has not been tested (§6.6). Reproduce the
  // ORIGINAL costs.js:34 behaviour and require the invariant above to catch it.
  const err = s3InvalidAccessKeyId();
  const leakyBody = { error: { code: 'internal', message: err.message,
                               upstream: 'upstream', ref: S.makeRef('cst') } };
  let caught = null;
  try {
    assertNoErrValueInBody(err, leakyBody, null);
  } catch (e) {
    caught = e;
  }
  assert.ok(caught, 'the leak invariant did NOT fail on a body containing err.message — '
                  + 'the guard is vacuous and proves nothing');
  assert.ok(/leaked into body|message not in vocabulary/.test(caught.message), caught.message);

  // And the ACCEPTANCE grep must also go RED on that same body.
  assert.ok(FORBIDDEN_RE.test(JSON.stringify(leakyBody)),
    'the ACCEPTANCE grep failed to detect a body that literally contains the leak');
};

// ── error fixtures ────────────────────────────────────────────────────────────

function sigMismatch() {
  const e = new Error('The request signature we calculated does not match the signature you provided.');
  e.name = 'SignatureDoesNotMatch'; e.$metadata = { httpStatusCode: 403 };
  return e;
}
function noCreds() {
  const e = new Error('Could not load credentials from any providers');
  e.name = 'CredentialsProviderError'; e.tryNextLink = false;
  return e;
}
function timeout() {
  const e = new Error('Connection timed out after 3000ms');
  e.name = 'TimeoutError'; e.$metadata = { httpStatusCode: 408 };
  return e;
}
function noSuchKey() {
  const e = new Error('The specified key does not exist.');
  e.name = 'NoSuchKey'; e.Code = 'NoSuchKey'; e.$metadata = { httpStatusCode: 404 };
  return e;
}
function throttled() {
  const e = new Error('Please reduce your request rate.');
  e.name = 'SlowDown'; e.$metadata = { httpStatusCode: 503 };
  return e;
}
function http500() {
  const e = new Error('We encountered an internal error. Please try again.');
  e.name = 'SomethingUnmapped'; e.$metadata = { httpStatusCode: 500 };
  return e;
}
function econnreset() {
  const e = new Error('socket hang up'); e.code = 'ECONNRESET';
  return e;
}
function plainError() { return new Error('kaboom in the widget factory'); }

// ── runner ────────────────────────────────────────────────────────────────────

let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name}\n      ${e.message}`);
  }
}
console.log(`\n${Object.keys(tests).length - failed} passed, ${failed} failed, `
          + `${Object.keys(tests).length} total`);
process.exit(failed ? 1 : 0);
