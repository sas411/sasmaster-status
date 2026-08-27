/**
 * WARROOM-OPSTIMELINE-001 — the one slot-state evaluator for the OPS 24h
 * timeline + Cron Today (§4 OPS, Phase 1's state enum). This is the single
 * function both the timeline dot and the (future) §2.2 alert rule must
 * consume — two independent evaluations of the same slot is exactly the
 * defect C4 names ("two implementations will drift and the drift will
 * favor green").
 *
 * DECISION GATES (ruled by Shiv 2026-08-26, verbatim in ~/SaSMaster/FEEDBACK.md,
 * mirrored in warroom/jobs.json's `_grace_minutes_comment`):
 *   - grace window mechanism = option (c), per-job, in the job manifest
 *     (warroom/jobs.json `grace_minutes`). NOT resolved: every job's actual
 *     value is still the literal string "UNSET" — Claude Code must not seed
 *     a default, so `missed` is NOT COMPUTABLE for any job this round. A slot
 *     that would otherwise be `missed` renders `grace_unset` instead — a 9th
 *     state added to the card's own 8-state enum because the card's own
 *     interim text ("slots render `N/A — grace window unset` in the
 *     interim") describes a real render branch, not a sub-case of an
 *     existing one. Every state below — including this one — has a legend
 *     entry (LEGEND), so `set(marks) ⊆ set(legend)` always holds (card VERIFY,
 *     legend completeness).
 *   - OPS refresh cadence = SSE, 30s cadence / 60s stale (READPLANE-001's
 *     answer, reused here per the card's explicit instruction not to re-rule
 *     it) — see warroom/cadence-registry.json `tabs.OPS`.
 *
 * `stuck` is NEVER computed here — it is imported verbatim from
 * WarroomRunstate.run_state() (the §2.7 watchdog), per the card's own red
 * constraint ("this card contains no second p95 comparison"). Likewise
 * `retired` is never assignable here (§5b is Shiv's) — an agent whose fleet
 * classification (active/on-demand/retired) is still pending renders
 * `unclassified`, never silently excluded and never `retired`.
 *
 * Dual-environment (CommonJS for api/ops/*.js + tests, global for
 * warroom-v5.html), same pattern as the other lib/warroom-*.js modules.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./warroom-runstate'));
  } else {
    root.WarroomOpsTimeline = factory(root.WarroomRunstate);
  }
})(typeof self !== 'undefined' ? self : this, function (WarroomRunstate) {
  'use strict';

  // Card Phase 1 enumeration, plus `grace_unset` (see header) and `error`
  // (C5 clock-skew / unrenderable — not named in Phase 1's list but required
  // by C2's four-render-state discipline extended to this domain: a broken
  // input must render ERROR, never a fabricated state).
  var STATES = {
    RAN_OK: 'ran_ok',
    RAN_FAILED: 'ran_failed',
    RUNNING: 'running',
    STUCK: 'stuck',
    MISSED: 'missed',
    PENDING: 'pending',
    NOT_SCHEDULED: 'not_scheduled',
    UNCLASSIFIED: 'unclassified',
    GRACE_UNSET: 'grace_unset',
    ERROR: 'error'
  };

  // One legend entry per state (card 🟡: "the legend renders on the tab, not
  // in a doc. Every state a dot can take has a legend entry; a state with no
  // entry is a build-time failure."). `hollow` drives the MISSED-specific
  // "hollow, red-outlined, text-labeled" render (Phase 3) — every other state
  // is a filled dot/pill.
  var LEGEND = [
    { state: STATES.RAN_OK, label: 'Ran OK', dotClass: 'st-ranok', hollow: false,
      description: 'A run-log record matches this slot and exit_code = 0.' },
    { state: STATES.RAN_FAILED, label: 'Ran, failed', dotClass: 'st-ranfailed', hollow: false,
      description: 'A run-log record matches this slot and exit_code != 0.' },
    { state: STATES.RUNNING, label: 'Running', dotClass: 'st-running', hollow: false,
      description: 'Non-terminal run-log record, within normal duration (§2.7 watchdog).' },
    { state: STATES.STUCK, label: 'Stuck', dotClass: 'st-stuck', hollow: false,
      description: 'Non-terminal record beyond 2×p95 — imported from the §2.7 watchdog, not recomputed here.' },
    { state: STATES.MISSED, label: 'Missed', dotClass: 'st-missed', hollow: true,
      description: 'Slot elapsed + grace window, no matching run-log record.' },
    { state: STATES.PENDING, label: 'Pending', dotClass: 'st-pending', hollow: false,
      description: 'Slot has not occurred yet today (or is within a set grace window awaiting its run).' },
    { state: STATES.NOT_SCHEDULED, label: 'Not scheduled', dotClass: 'st-notsched', hollow: false,
      description: 'No slot for this job falls inside the requested window.' },
    { state: STATES.UNCLASSIFIED, label: 'Unclassified (§5b)', dotClass: 'st-unclass', hollow: false,
      description: 'N/A — fleet classification (active/on-demand/retired) pending §5b. Never rendered as retired.' },
    { state: STATES.GRACE_UNSET, label: 'Grace unset', dotClass: 'st-graceunset', hollow: false,
      description: 'N/A — grace window unset. `missed` cannot be computed until Shiv sets this job’s grace_minutes.' },
    { state: STATES.ERROR, label: 'Error', dotClass: 'st-error', hollow: false,
      description: 'ERROR — query failure or clock skew. Never plotted as a normal mark (C5).' }
  ];

  function legendMap() {
    var m = {};
    LEGEND.forEach(function (e) { m[e.state] = e; });
    return m;
  }

  // Maps WarroomRunstate.run_state()'s non-terminal states onto this domain's
  // enum. `na_insufficient_history` (bootstrap gap, WarroomRunstate's own
  // documented interim) has no equivalent slot state — mapping it to
  // `running` is the honest non-committal choice already recommended by that
  // module's own comment ("explicitly NOT 'running' as a silent fallback"
  // refers to defaulting when the record COULD be stuck; here it genuinely
  // is non-terminal and not yet provably stuck, so `running` is correct, not
  // a fallback-of-convenience).
  function _mapNonTerminal(rsState) {
    if (rsState === 'stuck') return STATES.STUCK;
    if (rsState === 'running' || rsState === 'na_insufficient_history') return STATES.RUNNING;
    return STATES.ERROR;
  }

  /**
   * computeSlotState(input) -> {state, run_id, started_at, finished_at, reason, legend}
   *
   * input:
   *   job                string   -- job id, for error reporting only
   *   scheduledAtIso     string   -- this slot's scheduled UTC timestamp (ISO)
   *   now                Date     -- injected (C5), never computed internally
   *   hasCadence         boolean  -- false => NOT_SCHEDULED (no cron entry covers this job)
   *   alwaysOn           boolean  -- true for continuous daemons with no discrete cron slot
   *                                  (e.g. JARVIS) that are still fleet-unclassified
   *   fleetClassified    boolean  -- false => UNCLASSIFIED unconditionally (§5b gate).
   *                                  Defaults true (do not silently exclude, but do not
   *                                  invent a pending classification for jobs §5b already
   *                                  covers implicitly via jobs.json).
   *   graceMinutes       number|"UNSET" -- warroom/jobs.json's per-job value (C6: one source,
   *                                  read verbatim, never defaulted here)
   *   matchedRun         object|null -- the run_state()-shaped record (state, run_id,
   *                                  started_at, finished_at, reason) whose started_at the
   *                                  caller has already determined falls inside this slot's
   *                                  window, or null if none does (left join — unmatched
   *                                  slots survive, per Phase 2)
   *   terminalDurationsMs array|null -- forwarded to WarroomRunstate for the stuck watchdog
   *                                  when matchedRun is non-terminal
   */
  function computeSlotState(input) {
    input = input || {};
    var now = input.now instanceof Date ? input.now : new Date(input.now);
    var nowMs = now.getTime();

    if (input.fleetClassified === false) {
      return _result(STATES.UNCLASSIFIED, null, null, null, 'N/A — fleet classification pending (§5b)');
    }
    if (!input.hasCadence && !input.alwaysOn) {
      return _result(STATES.NOT_SCHEDULED, null, null, null, 'N/A — no slot for this job in this window');
    }
    if (!input.hasCadence && input.alwaysOn) {
      // Continuous daemon, no discrete slot to plot — still needs a state
      // per job/window, and §5b (is it active/on-demand/retired?) is exactly
      // what's undecided for this shape of job (e.g. JARVIS).
      return _result(STATES.UNCLASSIFIED, null, null, null, 'N/A — fleet classification pending (§5b)');
    }

    var scheduledAtMs = Date.parse(input.scheduledAtIso);
    if (isNaN(scheduledAtMs)) {
      return _result(STATES.ERROR, null, null, null, 'ERROR — invalid scheduled_at');
    }

    var matched = input.matchedRun;
    if (matched) {
      var startedMs = matched.started_at ? Date.parse(matched.started_at) : NaN;
      if (!isNaN(startedMs) && startedMs > nowMs) {
        return _result(STATES.ERROR, matched.run_id || null, matched.started_at || null, matched.finished_at || null, 'ERROR — clock skew');
      }
      if (matched.finished_at) {
        var rs = matched.state;
        if (rs === 'succeeded') return _result(STATES.RAN_OK, matched.run_id || null, matched.started_at || null, matched.finished_at || null, null);
        if (rs === 'failed' || rs === 'stale') return _result(STATES.RAN_FAILED, matched.run_id || null, matched.started_at || null, matched.finished_at || null, matched.reason || null);
        // Caller supplied a terminal record without a recognizable run_state
        // label (raw exit_code path) — decide from exit_code directly.
        if (typeof matched.exit_code !== 'undefined' && matched.exit_code !== null) {
          var ok = matched.exit_code === 0 || matched.exit_code === '0';
          return _result(ok ? STATES.RAN_OK : STATES.RAN_FAILED, matched.run_id || null, matched.started_at || null, matched.finished_at || null, null);
        }
        return _result(STATES.ERROR, matched.run_id || null, matched.started_at || null, matched.finished_at || null, 'ERROR — unrecognized terminal state');
      }
      // Non-terminal — consult the watchdog (WarroomRunstate), never re-derive.
      var rsResult = WarroomRunstate.run_state({
        job: input.job,
        latestRow: matched,
        terminalDurationsMs: input.terminalDurationsMs || null,
        now: now
      });
      return _result(_mapNonTerminal(rsResult.state), matched.run_id || null, matched.started_at || null, null, rsResult.reason || null);
    }

    // No matching run for this slot.
    if (scheduledAtMs > nowMs) {
      return _result(STATES.PENDING, null, null, null, 'N/A — no runs scheduled yet');
    }
    var grace = input.graceMinutes;
    if (typeof grace !== 'number' || !isFinite(grace) || grace < 0) {
      return _result(STATES.GRACE_UNSET, null, null, null, 'N/A — grace window unset');
    }
    var graceMs = grace * 60000;
    if (nowMs > scheduledAtMs + graceMs) {
      return _result(STATES.MISSED, null, null, null, 'MISSED — no matching run-log record within grace window');
    }
    // Elapsed but still inside a KNOWN grace window — not yet missed.
    return _result(STATES.PENDING, null, null, null, 'N/A — within grace window, awaiting run');
  }

  function _result(state, runId, startedAt, finishedAt, reason) {
    var out = { state: state, run_id: runId, started_at: startedAt, finished_at: finishedAt };
    if (reason) out.reason = reason;
    return out;
  }

  return {
    STATES: STATES,
    LEGEND: LEGEND,
    legendMap: legendMap,
    computeSlotState: computeSlotState
  };
});
