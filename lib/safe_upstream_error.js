'use strict';
/**
 * safe_upstream_error.js — classify an upstream failure without narrating it.
 *
 * SC2-P0-AWSKEY-001 Track B.  Owned by that card; `api/status.js` and
 * `api/ask.js` CONSUME THIS UNMODIFIED (§23).  Do not fork it — a second copy of
 * an error-sanitizing gate is how one of them silently stops being maintained.
 * Any change a sibling card needs is requested through SC2-P0-AWSKEY-001.
 *
 * THE DEFECT
 * ----------
 * `api/costs.js:34` was:
 *
 *     catch (err) { res.status(503).json({ error: 'costs unavailable', detail: err.message }); }
 *
 * `err.message` from the AWS SDK reached an unauthenticated public response
 * verbatim — observed 2026-08-18 as:
 *
 *     "The AWS Access Key Id you provided does not exist in our records."
 *
 * That one sentence tells an unauthenticated caller that this service holds AWS
 * IAM credentials, which credential it presented, and that the credential is
 * invalid — enough to distinguish "wrong account" from "revoked key" from "not
 * configured", which is exactly the oracle an attacker wants while probing.
 * Rotating the key does not fix it; the next upstream failure narrates the
 * infrastructure again.
 *
 * §34 CORRECTION TO THE CARD — MEASURED 2026-08-22
 * -------------------------------------------------
 * The card's CONTEXT carries `aws_cost_explorer` (`ce:GetCostAndUsage`) as the
 * upstream and marks it UNVERIFIED.  `api/costs.js`, read end to end this
 * session, shows the upstream is **S3 GetObject** on
 * `s3://sasmaster-2026/_observe/costs/latest.json`; there is no Cost Explorer
 * client anywhere in the file.  That is load-bearing, not trivia: S3's error
 * name for an unknown key id is `InvalidAccessKeyId`, and it is `InvalidAccessKeyId`
 * — not the STS names — that produces the exact leaked sentence above.  The
 * card's mapping table lists only `InvalidClientTokenId` /
 * `UnrecognizedClientException` / `SignatureDoesNotMatch`.  Implementing that
 * table as written would drop the ACTUAL observed production failure through to
 * `internal`/500: a misclassification of the one error this card exists to
 * classify.  The S3 credential family is added below.
 *
 * §34 CORRECTION 2 — THE CARD'S ENVELOPE CONTRADICTS ITS OWN ACCEPTANCE
 * ---------------------------------------------------------------------
 * The interface contract specifies a public body containing
 * `"upstream": "aws_cost_explorer"`, while ACCEPTANCE requires
 * `grep -ci "aws\|akia\|iam\|signature\|token" <body>` -> 0.  Those cannot both
 * hold: `aws_cost_explorer` contains "aws".  Resolved in favour of ACCEPTANCE,
 * because it is the stronger statement of the card's own security rule — naming
 * the cloud provider to an unauthenticated caller rebuilds a weaker version of
 * the very oracle being removed.
 *
 * So the split is enforced HERE, mechanically, not left to caller discipline
 * (§53 — gates are interlocks, not intentions):
 *   · `opts.upstream`    — the precise internal label (e.g. 'aws_s3').  LOG ONLY.
 *   · `opts.publicLabel` — a provider-neutral label for the public body.  Any
 *     label matching PROVIDER_DENY is REFUSED and replaced with 'upstream', and
 *     the refusal is recorded in `log.public_label_refused` (§41).
 * A future caller cannot leak the provider through this envelope even by
 * passing it deliberately.
 *
 * CONTRACT (§25)
 * --------------
 *   sanitize(err, { upstream, publicLabel, publicMessage, refPrefix })
 *     -> { status, body, log }
 *
 * Pure.  No I/O.  No AWS import.  No network.  Unit-testable offline.
 *
 *   body = { error: { code, message, upstream, ref } }
 *     code ∈ upstream_unavailable | upstream_unauthorized | not_configured | internal
 *
 * HARD RULE, enforced by test: **no value reachable from `err` may appear
 * anywhere in `body`.**  Every field of `body` is drawn from a closed vocabulary
 * defined in this file, from a caller-supplied label that passed the deny
 * filter, or from a freshly generated `ref`.  Nothing is interpolated from the
 * error object, on any path, including the fallback paths.
 *
 * §41 — THE GATE LOGS WHAT IT DROPS
 * ----------------------------------
 * `log` carries the FULL provider error under the same `ref` returned to the
 * caller.  A silently swallowed upstream error is worse than a leaked one: it is
 * a leaked one you cannot debug.  The caller MUST emit `log` at ERROR.
 *
 * REPLACEABILITY
 * --------------
 * Swapping S3 for a cached cost table, or moving to an OIDC role, requires ZERO
 * changes here: this module keys off "an upstream call raised", never off which
 * upstream or which auth mechanism.
 */

const crypto = require('crypto');

/** The complete, closed vocabulary of codes we will ever emit. */
const CODES = Object.freeze({
  UNAVAILABLE:    'upstream_unavailable',
  UNAUTHORIZED:   'upstream_unauthorized',
  NOT_CONFIGURED: 'not_configured',
  INTERNAL:       'internal',
});

/**
 * Caller-facing text.  Fixed strings; never provider-authored.
 *
 * Deliberately IDENTICAL for all three 503 classes.  `code` is for our
 * dashboards and canaries; `message` is what a human sees.  Differentiating the
 * public prose by class would rebuild the oracle this card removes.
 */
const MESSAGES = Object.freeze({
  [CODES.UNAVAILABLE]:    'This data is temporarily unavailable.',
  [CODES.UNAUTHORIZED]:   'This data is temporarily unavailable.',
  [CODES.NOT_CONFIGURED]: 'This data is temporarily unavailable.',
  [CODES.INTERNAL]:       'An internal error occurred.',
});

const HTTP = Object.freeze({
  [CODES.UNAVAILABLE]:    503,
  [CODES.UNAUTHORIZED]:   503,
  [CODES.NOT_CONFIGURED]: 503,
  [CODES.INTERNAL]:       500,
});

/** Structured-field names meaning "the credential was rejected". */
const UNAUTHORIZED_NAMES = new Set([
  // S3 / SigV4 — the family actually reachable from this endpoint (§34).
  'InvalidAccessKeyId',        // <- the observed 2026-08-18 production failure
  'SignatureDoesNotMatch',
  'AccessDenied',
  'AccessDeniedException',
  'InvalidToken',
  'ExpiredToken',
  'ExpiredTokenException',
  'TokenRefreshRequired',
  'AuthorizationHeaderMalformed',
  'RequestTimeTooSkewed',
  'InvalidObjectState',
  // STS / generic SigV4 — from the card's table.  Unreachable from costs.js
  // today, but free, and this module is shared with handlers calling elsewhere.
  'InvalidClientTokenId',
  'UnrecognizedClientException',
  'AuthFailure',
]);

/** "We never had a usable credential or client" — distinct from "rejected". */
const NOT_CONFIGURED_NAMES = new Set([
  'CredentialsProviderError',
  'CredentialsError',
  'ConfigError',
  'InvalidClientConfig',
  'ProviderError',
]);

/** Transient: retryable, or the artifact simply is not there yet. */
const UNAVAILABLE_NAMES = new Set([
  'TimeoutError',
  'RequestTimeout',
  'RequestAbortedError',
  'NetworkingError',
  'ThrottlingException',
  'SlowDown',
  'ServiceUnavailable',
  'InternalError',
  'PriorRequestNotComplete',
  // The cost artifact has not been published.  §39: the surface renders `—`
  // with a note, never $0 and never a stale figure presented as current.
  'NoSuchKey',
  'NoSuchBucket',
]);

/** Node-level network failures arrive on `err.code`, not `err.name`. */
const UNAVAILABLE_SYSCALLS = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN',
  'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'ERR_SOCKET_CONNECTION_TIMEOUT',
]);

/**
 * Anything a public label may NOT contain.  Mirrors the card's ACCEPTANCE grep
 * (`aws|akia|iam|signature|token`) and extends it to the other providers and to
 * credential words, so this module stays correct if the upstream is ever
 * swapped.  Matched case-insensitively, as a substring.
 */
const PROVIDER_DENY = [
  'aws', 'akia', 'asia', 'amazon', 's3', 'iam', 'sts', 'gcp', 'google',
  'azure', 'signature', 'token', 'secret', 'credential', 'key', 'arn',
  'bucket', 'motherduck', 'anthropic', 'railway', 'vercel',
];

const SAFE_LABEL_RE = /^[a-z0-9_]{1,40}$/;
const NEUTRAL_LABEL = 'upstream';
const REF_RE = /^[a-z]{2,8}_\d{8}T\d{6}Z_[0-9a-f]{12}$/;

function makeRef(prefix) {
  const p = (typeof prefix === 'string' && /^[a-z]{2,8}$/.test(prefix)) ? prefix : 'err';
  const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `${p}_${ts}_${crypto.randomBytes(6).toString('hex')}`;
}

/**
 * Reduce a caller-supplied label to something safe to publish.
 * Returns { label, refused } — `refused` is the rejected input, for the log.
 */
function publicLabelFor(raw) {
  if (typeof raw !== 'string' || raw === '') return { label: NEUTRAL_LABEL, refused: null };
  const lowered = raw.toLowerCase();
  if (!SAFE_LABEL_RE.test(lowered)) return { label: NEUTRAL_LABEL, refused: raw.slice(0, 60) };
  for (const bad of PROVIDER_DENY) {
    if (lowered.includes(bad)) return { label: NEUTRAL_LABEL, refused: raw.slice(0, 60) };
  }
  return { label: lowered, refused: null };
}

/** Public message: closed default, or a caller string reduced to safe prose. */
function publicMessageFor(raw, code) {
  if (typeof raw !== 'string' || raw === '') return MESSAGES[code];
  const cleaned = raw.replace(/[^A-Za-z0-9 .,'()-]/g, '').slice(0, 120).trim();
  if (!cleaned) return MESSAGES[code];
  const lowered = cleaned.toLowerCase();
  for (const bad of PROVIDER_DENY) {
    if (lowered.includes(bad)) return MESSAGES[code];
  }
  return cleaned;
}

/**
 * Classify by STRUCTURED FIELDS ONLY.
 *
 * Never by substring-matching the human-readable message (card Phase 1 step 6).
 * Provider prose is not an API: it changes without notice, it is localised, and
 * matching on it is how a classifier silently starts returning `internal` for
 * the one failure it was built for.
 */
function safeGet(obj, key) {
  // A property read can THROW: `{ get name() { throw ... } }` is a legal error
  // shape, and an SDK error wrapping a proxy is not exotic. This module runs
  // inside a handler's catch block; if it throws, the platform's own default
  // error page is what reaches the caller — which is exactly the disclosure
  // this card removes. Every read goes through here.
  if (obj === null || obj === undefined) return undefined;
  if (typeof obj !== 'object' && typeof obj !== 'function') return undefined;
  try { return obj[key]; } catch (_) { return undefined; }
}

function classify(err) {
  if (err === null || err === undefined) return CODES.INTERNAL;
  if (typeof err !== 'object' && typeof err !== 'function') return CODES.INTERNAL;

  const rawName = safeGet(err, 'name');
  const name = typeof rawName === 'string' ? rawName : '';
  const rawCodeUpper = safeGet(err, 'Code');
  const rawCodeLower = safeGet(err, 'code');
  const awsCode = typeof rawCodeUpper === 'string' ? rawCodeUpper
                : (typeof rawCodeLower === 'string' ? rawCodeLower : '');
  const rawMeta = safeGet(err, '$metadata');
  const meta = (rawMeta && typeof rawMeta === 'object') ? rawMeta : {};
  const metaStatus = safeGet(meta, 'httpStatusCode');
  const errStatus = safeGet(err, 'statusCode');
  const httpStatus = Number.isInteger(metaStatus) ? metaStatus
                   : (Number.isInteger(errStatus) ? errStatus : 0);

  for (const candidate of [name, awsCode]) {
    if (!candidate) continue;
    if (NOT_CONFIGURED_NAMES.has(candidate)) return CODES.NOT_CONFIGURED;
    if (UNAUTHORIZED_NAMES.has(candidate))   return CODES.UNAUTHORIZED;
    if (UNAVAILABLE_NAMES.has(candidate))    return CODES.UNAVAILABLE;
    if (UNAVAILABLE_SYSCALLS.has(candidate)) return CODES.UNAVAILABLE;
  }

  if (httpStatus === 401 || httpStatus === 403) return CODES.UNAUTHORIZED;
  if (httpStatus === 404)                       return CODES.UNAVAILABLE;
  if (httpStatus === 408 || httpStatus === 429) return CODES.UNAVAILABLE;
  if (httpStatus >= 500 && httpStatus <= 599)   return CODES.UNAVAILABLE;

  return CODES.INTERNAL;
}

/**
 * @param {unknown} err  the caught error, any shape (including null/undefined)
 * @param {{upstream?:string, publicLabel?:string, publicMessage?:string,
 *          refPrefix?:string}} [opts]
 * @returns {{status:number, body:object, log:object}}
 */
function sanitize(err, opts) {
  const options = (opts && typeof opts === 'object') ? opts : {};
  const ref = makeRef(options.refPrefix);
  try {
    return build(err, options, ref);
  } catch (internalFailure) {
    // TOTAL FALLBACK. The sanitizer itself failed. Emit the safest possible
    // envelope rather than letting the exception escape the handler's catch
    // block — an unhandled throw here means the platform's default error page,
    // and this card exists to stop exactly that class of narration.
    return {
      status: HTTP[CODES.INTERNAL],
      body: { error: { code: CODES.INTERNAL, message: MESSAGES[CODES.INTERNAL],
                       upstream: NEUTRAL_LABEL, ref } },
      log: { event: 'upstream_error_sanitizer_failed', ref,
             sanitizer_error: safeString(internalFailure && internalFailure.message, 500) },
    };
  }
}

function build(err, options, ref) {
  const code = classify(err);
  const { label, refused } = publicLabelFor(options.publicLabel);

  // Every field below comes from the closed vocabulary, from a caller label
  // that passed the deny filter, or from `ref`.  Nothing is read off `err`.
  const body = {
    error: {
      code,
      message: publicMessageFor(options.publicMessage, code),
      upstream: label,
      ref,
    },
  };

  // §41 — the full provider error, server-side only, under the same ref.
  const log = {
    event: 'upstream_error_sanitized',
    ref,
    upstream: safeString(options.upstream, 60) || 'unknown',   // precise, log-only
    public_label: label,
    code,
    http_status: HTTP[code],
    provider_name: safeString(safeGet(err, 'name')),
    provider_code: safeString(safeGet(err, 'Code') || safeGet(err, 'code')),
    provider_http_status: extractHttpStatus(err),
    provider_request_id: safeString(safeGet(safeGet(err, '$metadata'), 'requestId')),
    provider_message: safeString(safeGet(err, 'message'), 2000),
    stack: safeString(safeGet(err, 'stack'), 4000),
  };
  if (refused !== null) {
    log.public_label_refused = refused;
    log.public_label_refused_reason =
      'label named a provider or credential term; replaced with the neutral label';
  }

  return { status: HTTP[code], body, log };
}

function extractHttpStatus(err) {
  const meta = safeGet(err, '$metadata');
  const metaStatus = safeGet(meta, 'httpStatusCode');
  if (Number.isInteger(metaStatus)) return metaStatus;
  const errStatus = safeGet(err, 'statusCode');
  if (Number.isInteger(errStatus)) return errStatus;
  return null;
}

function safeString(v, max) {
  if (v === null || v === undefined) return null;
  const limit = typeof max === 'number' ? max : 500;
  try {
    return String(v).slice(0, limit);
  } catch (_) {
    return null;
  }
}

module.exports = {
  sanitize, classify, safeGet, publicLabelFor, publicMessageFor, makeRef,
  CODES, MESSAGES, HTTP, PROVIDER_DENY, REF_RE, NEUTRAL_LABEL,
};
