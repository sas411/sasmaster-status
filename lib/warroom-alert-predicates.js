// WARROOM-SYNTHETIC-001 — pure, DB-free alert-rule predicates.
//
// WHY THIS FILE EXISTS: ~/SaSMaster/scripts/alert-engine.js's rule functions
// (ruleJobMissedOrFailed/R3-R4, ruleStuckWatchdog, ruleR2) each inline their
// decision logic together with a live `mdQuery()` call against
// `sasmaster.ops.run_log` / the real feed files on disk. That means the only
// way to previously test "does this rule fire" was to either (a) mutate
// production data (forbidden — WARROOM-SYNTHETIC-001 ground rules) or (b) not
// test it at all. This module extracts the DECISION half of each rule (given
// already-fetched data, does it alert, and with what payload) as a pure
// function with zero I/O — alert-engine.js's rule functions now call these
// (behavior-preserving refactor, see the diff in alert-engine.js), and the
// synthetic suite calls the SAME functions directly with synthetic inputs.
// This is C6 in the harness itself: one evaluation, two callers (production
// engine, test suite) — never two independent re-implementations of "does it
// alert."
//
// Every function here is pure: no fs, no mdQuery, no network, no Date.now().
// Every alert object returned matches the shape emitAlert() in alert-engine.js
// expects: {rule_id, subject, severity, provenance_id, provenance_kind,
// source_age_seconds, source_cadence_seconds, message}. Returns null when the
// rule does not fire.

'use strict';

// R4 — refresh job failed or wrote zero rows. Mirrors alert-engine.js's
// ruleJobMissedOrFailed's post-fetch branch exactly (that function still owns
// the R3 "no row at all -> missing" branch and the mdQuery fetch; this is the
// R4 half, extracted because it is the half every S2-shaped scenario tests).
function evaluateJobFailedOrZeroRows(row, subject) {
  if (!row) return null; // R3 (missing) is the caller's concern, not this predicate's
  var exitCode = row.exit_code;
  var rowsWritten = row.rows_written;
  var isFailed = (exitCode != null && exitCode !== 0) || rowsWritten === 0;
  if (!isFailed) return null;
  return {
    rule_id: 'R4',
    subject: subject,
    severity: 'critical',
    provenance_id: row.run_id,
    provenance_kind: 'run_id',
    source_age_seconds: null,
    source_cadence_seconds: null,
    message: subject + ' run ' + row.run_id + ': exit_code=' + exitCode +
      ', rows_written=' + rowsWritten + ', error=' + (row.error || 'n/a') +
      ' — R4 job-failed-or-zero-rows',
  };
}

// Stuck watchdog — mirrors alert-engine.js's ruleStuckWatchdog's post-run_state
// branch. Takes the SAME run_state() result the OPS/DATA/QUEUE tiles render
// from (lib/warroom-runstate.js) — never a second computation of "is it stuck."
function evaluateStuckWatchdog(runStateResult, job) {
  if (!runStateResult || runStateResult.state !== 'stuck') return null;
  var rs = runStateResult;
  return {
    rule_id: 'stuck',
    subject: job,
    severity: 'warning',
    provenance_id: rs.run_id,
    provenance_kind: 'run_id',
    source_age_seconds: rs.source_age != null ? Math.round(rs.source_age / 1000) : null,
    source_cadence_seconds: null,
    message: job + ' is STUCK: run ' + rs.run_id + ' started ' + rs.started_at +
      ', no terminal record, ' + rs.reason +
      ' (threshold=' + (rs.threshold != null ? Math.round(rs.threshold / 1000) + 's' : 'n/a') +
      ', p95=' + (rs.p95 != null ? Math.round(rs.p95 / 1000) + 's' : 'n/a') + ')',
  };
}

// R2 — feed staleness. Mirrors alert-engine.js's ruleR2 per-feed branch, minus
// the fs.statSync() age lookup and the hardcoded production FEED_PATHS map —
// caller supplies ageSec (from wherever: a real file stat, or a synthetic
// fixture value) and this decides whether it alerts.
function evaluateFeedStaleness(feed, ageSec, cadenceSec, source, absPath) {
  if (cadenceSec == null) {
    return {
      rule_id: 'R2', subject: feed, severity: 'info',
      provenance_id: 'config:cadence-registry:' + feed, provenance_kind: 'query_id',
      source_age_seconds: null, source_cadence_seconds: null,
      message: 'N/A — no cadence declared for ' + feed + ' (' + source + ')',
    };
  }
  if (ageSec == null) {
    return {
      rule_id: 'R2', subject: feed, severity: 'warning',
      provenance_id: 'file:' + absPath, provenance_kind: 'query_id',
      // NOTE: original inline ruleR2 passed neither source_age_seconds nor
      // source_cadence_seconds on this branch (both undefined -> persisted
      // as SQL NULL). Kept identical here deliberately -- do not "improve"
      // this without noting it as a behavior change, since the refactor's
      // whole premise is behavior-preservation.
      source_age_seconds: null, source_cadence_seconds: null,
      message: 'ERROR — could not read ' + feed + ' at ' + absPath + ' to compute age',
    };
  }
  if (ageSec > cadenceSec * 2) {
    return {
      rule_id: 'R2', subject: feed, severity: 'warning',
      provenance_id: 'file:' + absPath, provenance_kind: 'query_id',
      source_age_seconds: ageSec, source_cadence_seconds: cadenceSec,
      message: feed + ' is ' + Math.round(ageSec / 3600) + 'h old, declared cadence ' +
        Math.round(cadenceSec / 3600) + 'h (source: ' + source + ') — exceeds cadence x2',
    };
  }
  return null; // within cadence — no alert
}

// Persist-update field set — mirrors the SET clause alert-engine.js's
// persist() now builds on the 'open'/'reopen' branches (the
// WARROOM-ALERT-001 close-out provenance-refresh fix). Returned as a plain
// object (not SQL) so the synthetic suite can assert on field PRESENCE
// without executing anything against MotherDuck. If this list ever drops
// back to {last_seen_utc, message, severity} only (the pre-fix regression),
// the S-ALERT-PROVENANCE regression test below catches it.
function buildAlertUpdateFields(alert, now) {
  return {
    last_seen_utc: now,
    message: alert.message,
    severity: alert.severity,
    provenance_id: alert.provenance_id,
    provenance_kind: alert.provenance_kind,
    source_age_seconds: alert.source_age_seconds,
    source_cadence_seconds: alert.source_cadence_seconds,
  };
}

// Self-monitor — WARROOM-SYNTHETIC-001 CONSTRAINTS: "the suite's own failure
// is an alert. If the suite does not run, or errors before completing, that
// silence must page." Pure: given the last recorded heartbeat and the
// suite's declared window, decides whether the missed-window rule fires.
// Same shape as the other predicates here (alert object or null) so it can
// be wired into the real rule set the same way once §5c rules a cadence.
function evaluateMissedSuiteWindow(lastHeartbeatIso, windowSeconds, now) {
  var nowMs = (now instanceof Date ? now : new Date(now)).getTime();
  if (!lastHeartbeatIso) {
    return {
      rule_id: 'suite_silence', subject: 'warroom-synthetic-suite', severity: 'critical',
      provenance_id: 'query:heartbeat:missing', provenance_kind: 'query_id',
      source_age_seconds: null, source_cadence_seconds: windowSeconds,
      message: 'warroom-synthetic-suite has never recorded a heartbeat — suite silence must page',
    };
  }
  var heartbeatMs = Date.parse(lastHeartbeatIso);
  var ageSec = (nowMs - heartbeatMs) / 1000;
  if (ageSec > windowSeconds) {
    return {
      rule_id: 'suite_silence', subject: 'warroom-synthetic-suite', severity: 'critical',
      provenance_id: 'heartbeat:' + lastHeartbeatIso, provenance_kind: 'query_id',
      source_age_seconds: Math.round(ageSec), source_cadence_seconds: windowSeconds,
      message: 'warroom-synthetic-suite missed its window: last heartbeat ' + lastHeartbeatIso +
        ' is ' + Math.round(ageSec) + 's old, window is ' + windowSeconds + 's',
    };
  }
  return null;
}

module.exports = {
  evaluateJobFailedOrZeroRows: evaluateJobFailedOrZeroRows,
  evaluateStuckWatchdog: evaluateStuckWatchdog,
  evaluateFeedStaleness: evaluateFeedStaleness,
  buildAlertUpdateFields: buildAlertUpdateFields,
  evaluateMissedSuiteWindow: evaluateMissedSuiteWindow,
};
