// WARROOM-READPLANE-001 MAINTAINER Gap A fix (2026-08-26) — real alert-plane
// write on query-budget breach. warroom/query-budget.json's `on_breach` field
// has always claimed "emit rule_id='budget_breach' to sasmaster.ops.alerts";
// no such write existed anywhere in code until this file (MAINTAINER's
// finding, DONE_LOG 2026-08-26). Reuses ~/SaSMaster/scripts/alert-engine.js's
// exact insert/dedup pattern (mdQuery via duckdb CLI + MOTHERDUCK_TOKEN,
// alert_id = sha256(rule_id::subject), open/update/reopen state machine)
// rather than reinventing it (C6 — one convention for writing this table).
//
// ⚠️ DISCLOSED ARCHITECTURE GAP, same class as warroom-readplane.js's
// fetchTileData note: this function shells out to the `duckdb` CLI binary
// and reads MOTHERDUCK_TOKEN from process.env first, then ~/SaSMaster/.env.
// Vercel's serverless runtime has neither the duckdb binary nor that local
// file mounted — calling this from api/state/*.js in actual deployed
// production will throw, and the caller MUST catch it, log a [WARN], and
// never let a failed alert write block or corrupt the tile response (silent-
// swallow is banned, but so is crashing the read plane over a best-effort
// side write). This IS genuinely wired and genuinely tested end-to-end for
// any environment that has duckdb + the token (confirmed locally this
// session, see DONE_LOG self-check) — the deployed-Vercel gap is the same
// unsolved "no MotherDuck client wired into Vercel" limitation already
// disclosed at the top of warroom-readplane.js, not a new one.
'use strict';

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DUCKDB_BIN = process.env.RUNLOG_DUCKDB_BIN || '/opt/homebrew/bin/duckdb';

function loadToken() {
  if (process.env.MOTHERDUCK_TOKEN) return process.env.MOTHERDUCK_TOKEN;
  const envFile = path.join(process.env.HOME || '', 'SaSMaster/.env');
  const raw = fs.readFileSync(envFile, 'utf8');
  const m = raw.match(/^(?:MOTHERDUCK_TOKEN|motherduck_token)=(.+)$/m);
  if (!m) throw new Error('MOTHERDUCK_TOKEN not found in process.env or ' + envFile);
  return m[1].trim();
}

function mdQuery(sql) {
  const token = loadToken();
  const out = execFileSync(
    DUCKDB_BIN,
    ['md:sasmaster', '-json', '-c', sql],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, env: Object.assign({}, process.env, { MOTHERDUCK_TOKEN: token }) }
  );
  const trimmed = out.trim();
  if (!trimmed) return [];
  try {
    return JSON.parse(trimmed);
  } catch (e) {
    return [];
  }
}

function sqlStr(v) {
  if (v === null || v === undefined) return 'NULL';
  return "'" + String(v).replace(/'/g, "''") + "'";
}
function sqlTs(d) {
  if (d === null || d === undefined) return 'NULL';
  const iso = (d instanceof Date ? d : new Date(d)).toISOString();
  return "'" + iso.replace('T', ' ').replace('Z', '') + "'";
}
function alertId(ruleId, subject) {
  return crypto.createHash('sha256').update(ruleId + '::' + subject).digest('hex').slice(0, 32);
}

// Emits/dedupes rule_id='budget_breach' for `tab` (subject). `provenance` is
// whatever query/execution id is on hand: { query_id, count, cap }. Same
// dedup semantics as alert-engine.js: open -> update last_seen, resolved ->
// reopen, missing -> insert. Table-write only — no live Slack (this session's
// constraint, same as every other alert-writing card).
function emitBudgetBreachAlert(tab, provenance) {
  const now = new Date();
  const ruleId = 'budget_breach';
  const subject = tab;
  const id = alertId(ruleId, subject);
  const message =
    'WARROOM-READPLANE-001: ' + tab + ' tab exceeded its daily query cap (' +
    (provenance && provenance.count) + '/' + (provenance && provenance.cap) +
    '); serving cached last-successful payload with freshness recomputed.';

  const existing = mdQuery("SELECT alert_id, state FROM sasmaster.ops.alerts WHERE alert_id = '" + id + "'");
  if (existing.length === 0) {
    mdQuery(
      'INSERT INTO sasmaster.ops.alerts VALUES (' +
        "'" + id + "', " + sqlStr(ruleId) + ', ' + sqlStr(subject) + ", 'warning', 'open', " +
        sqlStr((provenance && provenance.query_id) || null) + ", 'query_id', " +
        'NULL, NULL, ' +
        sqlStr(message) + ', ' + sqlTs(now) + ', ' + sqlTs(now) + ', NULL, NULL' +
      ')'
    );
    return { written: true, action: 'opened', alert_id: id };
  }
  if (existing[0].state === 'open') {
    mdQuery(
      "UPDATE sasmaster.ops.alerts SET last_seen_utc = " + sqlTs(now) +
      ', message = ' + sqlStr(message) + " WHERE alert_id = '" + id + "'"
    );
    return { written: true, action: 'updated', alert_id: id };
  }
  mdQuery(
    "UPDATE sasmaster.ops.alerts SET state='open', last_seen_utc = " + sqlTs(now) +
    ', resolved_at_utc=NULL, message = ' + sqlStr(message) + " WHERE alert_id = '" + id + "'"
  );
  return { written: true, action: 'reopened', alert_id: id };
}

module.exports = { emitBudgetBreachAlert, alertId };
