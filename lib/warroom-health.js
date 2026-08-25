/**
 * WARROOM-HEALTH-001 — the one health evaluator (C6).
 *
 * Replaces the literal `status = hardError ? 'error' : routingErr ? 'routing' : 'healthy'`
 * (generate-status.js:316, pre-fix) — which asserted `healthy` on any agent whose last log
 * line didn't match an error pattern, with NO age check against cadence at all. This is why
 * JARVIS rendered HEALTHY 83 days after its last run.
 *
 * Precedence (WARROOM-HEALTH-001 card, Phase 3): retired -> failed -> never_run -> blocked
 * -> healthy -> late -> stale -> na (no cadence declared).
 *
 * GATE-A (Shiv-only): the spec itself contradicts on the stale multiplier (S2.1 says x3, C4
 * says x2). This module ships AGENT_STALE_MULT/FEED_STALE_MULT as named constants with NO
 * default committed to production config -- callers MUST pass them explicitly. There is no
 * fallback default inside evaluateHealth() itself; omitting them is a caller error (throws),
 * not a silently-guessed threshold.
 *
 * Dual-environment (CommonJS for generate-status.js, global for warroom-v5.html), same
 * pattern as lib/warroom-clock.js (C6 -- one house style, not a second convention).
 */
(function (root) {
  'use strict';

  // Healthy ceiling is fixed at 1.5x cadence per the card's own precedence table (not a
  // GATE-A knob -- GATE-A is specifically the late/stale boundary contradiction).
  var HEALTHY_MULT = 1.5;

  function _daysAge(ms) {
    var d = ms / 86400000;
    if (d < 1) return Math.round(ms / 3600000) + 'h';
    return Math.round(d) + 'd';
  }

  /**
   * evaluateHealth(input) -> {state, age, reason, inputs}
   *
   * input:
   *   last_run          Date|string|null  -- most recent run_log.started_at for this job, or null (no run record)
   *   last_exit         number|null       -- run_log.exit_code for that row, or null if in-flight/no record
   *   cadence_ms        number|null       -- observed cadence in ms (from real scheduler config), or null (no declared cadence)
   *   expected_state    'active'|'on-demand'|'retired'
   *   has_run_record    boolean           -- explicit, not inferred from last_run truthiness (a run can legitimately have last_run=null pre-completion)
   *   blocked_signal     {reason:string}|null  -- structured signal only, never a log-prose regex match (C7)
   *   now               Date              -- from WarroomClock.nowUtc(), never recomputed (C5/C6)
   *   agentStaleMult    number            -- REQUIRED, no default (GATE-A) -- late/stale boundary multiplier
   *   feedStaleMult     number            -- REQUIRED, no default (GATE-A) -- reserved for feed-tile callers, unused by the agent path but part of the shared contract
   *
   * state in: 'retired' | 'failed' | 'never_run' | 'blocked' | 'healthy' | 'late' | 'stale' | 'na'
   */
  function evaluateHealth(input) {
    if (!input || input.now == null) {
      throw new Error('evaluateHealth: now is required (from WarroomClock.nowUtc())');
    }
    if (typeof input.agentStaleMult !== 'number' || typeof input.feedStaleMult !== 'number') {
      throw new Error('evaluateHealth: agentStaleMult/feedStaleMult are required, no default (GATE-A unresolved) -- caller must pass the configured constants');
    }

    var now = input.now instanceof Date ? input.now : new Date(input.now);
    var inputs = {
      last_run: input.last_run || null,
      last_exit: (input.last_exit === undefined) ? null : input.last_exit,
      cadence_ms: (input.cadence_ms === undefined) ? null : input.cadence_ms,
      expected_state: input.expected_state || 'active',
      age: null
    };

    // retired -- excluded from numerator AND denominator by the caller, but the evaluator
    // itself still returns a real state rather than throwing, so a stray render call on a
    // retired agent fails safe (visibly retired, not silently healthy).
    if (inputs.expected_state === 'retired') {
      return { state: 'retired', age: null, reason: 'agent classification is retired (S5b)', inputs: inputs };
    }

    var lastRunDate = inputs.last_run ? (inputs.last_run instanceof Date ? inputs.last_run : new Date(inputs.last_run)) : null;
    var ageMs = lastRunDate ? (now.getTime() - lastRunDate.getTime()) : null;
    if (ageMs != null) inputs.age = _daysAge(ageMs);

    // failed -- a run record exists AND its exit code is non-zero. Checked before never_run
    // because "has a run record" is the discriminator, not "was the most recent run a
    // success" -- an agent with ANY failed terminal row for its most recent run is failed,
    // not healthy-then-forgotten.
    if (input.has_run_record && inputs.last_exit != null && inputs.last_exit !== 0) {
      return { state: 'failed', age: inputs.age, reason: 'most recent run exited non-zero', inputs: inputs };
    }

    // never_run -- no run record at all. This is a correct, honest answer (S3.1), not a gap.
    if (!input.has_run_record) {
      return { state: 'never_run', age: null, reason: 'no run record', inputs: inputs };
    }

    // blocked -- structured signal only (C7). Never derived by regexing log prose.
    if (input.blocked_signal && input.blocked_signal.reason) {
      return { state: 'blocked', age: inputs.age, reason: input.blocked_signal.reason, inputs: inputs };
    }

    // No declared cadence -- healthy/late/stale are all cadence-relative, so evaluation
    // stops here per C2 rather than guessing a threshold. A run record with exit=0 and no
    // cadence is still 'na', not 'healthy' -- "ran fine once" and "trustworthy on a schedule"
    // are different claims.
    if (inputs.cadence_ms == null) {
      return { state: 'na', age: inputs.age, reason: 'no cadence declared', inputs: inputs };
    }

    if (ageMs <= inputs.cadence_ms * HEALTHY_MULT) {
      return { state: 'healthy', age: inputs.age, reason: null, inputs: inputs };
    }
    if (ageMs <= inputs.cadence_ms * input.agentStaleMult) {
      return { state: 'late', age: inputs.age, reason: 'age exceeds ' + HEALTHY_MULT + 'x cadence', inputs: inputs };
    }
    return { state: 'stale', age: inputs.age, reason: 'age exceeds ' + input.agentStaleMult + 'x cadence', inputs: inputs };
  }

  var api = { evaluateHealth: evaluateHealth, HEALTHY_MULT: HEALTHY_MULT };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof root !== 'undefined') {
    root.WarroomHealth = api;
  }
})(typeof window !== 'undefined' ? window : this);
