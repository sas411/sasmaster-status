// SC2-P0-EGRESS-001 — the public projection of the platform status document.
//
// `GET /api/status` served 140,180 bytes of internal platform state to any origin with
// no authentication of any kind: the live job queue with task ids, 51 agent definitions
// with their log paths and schedules, 44 tasks, and the cron table INCLUDING each job's
// full shell `command`. That is an internal console rendered as JSON on a public URL.
//
// THIS MODULE IS AN ALLOW-LIST, NOT A REDACTOR (§38).
//
// It constructs a NEW object and copies in ONLY the fields named below. It never takes
// the internal object and deletes keys. That direction matters: a deny-list silently
// re-leaks every field added later, which is exactly how this endpoint reached 140KB —
// one convenient field at a time, with nobody drawing a line between "what the operator
// sees" and "what the world sees".
//
// The durable artefact that stops it regrowing is docs/status-payload-classification.md:
// the next person to add a field reads it and knows which bucket the field lands in
// BEFORE it ships.
//
// §39 — nothing is guessed. A value that is absent or unrecognised in the internal
// document is emitted as `null`, never inferred, never defaulted to a healthy-looking
// value. The KEY SET is stable regardless, because ACCEPTANCE asserts exact key-set
// equality against docs/status-public-allowlist.txt.

'use strict';

const PUBLIC_SCHEMA_VERSION = 1;

// MEASURED 2026-08-22 against the live status document (status.json, 146,385 bytes,
// generated 2026-08-22T09:11:26Z): health.component_bands has exactly these four keys.
// These are generic SUBSYSTEM CATEGORIES, not service names, hostnames, job ids or
// agent names. Publishing them discloses that the platform has agents, canaries, cron
// and data-freshness — which the existence of a status page already implies.
//
// DECISION (card Phase 2, item 3 — "real service names, or opaque public labels?"):
// publish the four category names as-is. Opaque labels would make the endpoint useless
// for its one legitimate purpose without materially reducing disclosure. The values
// published are BANDS (ok/degraded/down), never the numeric component scores.
const COMPONENT_NAMES = Object.freeze(['agents', 'canaries', 'cron', 'freshness']);

// Internal band vocabulary -> public status vocabulary. Anything not in this map is
// UNKNOWN and becomes null (§39: never guess, never default to "ok").
const BAND_TO_STATUS = Object.freeze({
  green: 'ok',
  amber: 'degraded',
  red:   'down',
});

function mapBand(band) {
  if (typeof band !== 'string') return null;
  return Object.prototype.hasOwnProperty.call(BAND_TO_STATUS, band)
    ? BAND_TO_STATUS[band]
    : null;
}

function isoOrNull(v) {
  // Accept only an ISO-8601-shaped string. A number, an object, or free text is not a
  // timestamp we are willing to publish.
  return (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z?$/.test(v)) ? v : null;
}

/**
 * Project the internal status document down to the public document.
 *
 * @param {object} internal  the parsed internal status document
 * @returns {{status: string|null, checked_at: string|null,
 *            components: Record<string,string|null>, schema_version: number}}
 */
function toPublicStatus(internal) {
  const doc = (internal && typeof internal === 'object' && !Array.isArray(internal))
    ? internal
    : {};
  const health = (doc.health && typeof doc.health === 'object') ? doc.health : {};
  const bands  = (health.component_bands && typeof health.component_bands === 'object')
    ? health.component_bands
    : {};

  // ── field 1: status ──────────────────────────────────────────────────────────
  // AUTHORITY: status.json.health.grade (ONE-SOURCE-001 names health as the health
  // authority; the frontend reads it directly). Deliberately NOT health.score — a
  // precise numeric score is derived from internal component weights and is O-bucket.
  const status = mapBand(health.grade);

  // ── field 2: checked_at ──────────────────────────────────────────────────────
  // health.computed_at is the moment the health verdict was computed. generated_at is
  // the fallback (the moment the whole document was written).
  const checked_at = isoOrNull(health.computed_at) || isoOrNull(doc.generated_at);

  // ── field 3: components ──────────────────────────────────────────────────────
  // Built from the fixed COMPONENT_NAMES list, NOT from Object.keys(bands). Iterating
  // the internal object would silently publish any component added later — the exact
  // deny-list failure this module exists to avoid.
  const components = {};
  for (const name of COMPONENT_NAMES) components[name] = mapBand(bands[name]);

  // ── field 4: schema_version ──────────────────────────────────────────────────
  // A constant. Bump it when the public shape changes, so a consumer can detect it.
  return { status, checked_at, components, schema_version: PUBLIC_SCHEMA_VERSION };
}

/**
 * The exact key set the public document emits, in the `a.b.c` form the ACCEPTANCE
 * block diffs against docs/status-public-allowlist.txt. Derived from the projection
 * itself so the allow-list file and the code cannot drift apart.
 */
function publicKeyPaths() {
  const out = ['checked_at', 'schema_version', 'status'];
  for (const n of COMPONENT_NAMES) out.push(`components.${n}`);
  return out.sort();
}

module.exports = {
  toPublicStatus,
  publicKeyPaths,
  PUBLIC_SCHEMA_VERSION,
  COMPONENT_NAMES,
  BAND_TO_STATUS,
};
