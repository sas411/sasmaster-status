/**
 * WARROOM-NOWPLANE-001 — the RUNNING NOW panel's data/state layer (C6: a
 * *surface* of WARROOM-RUNSTATE-001's state machine, never a second one).
 *
 * This module owns:
 *   1. now_plane() — the pure composition described in the card's `exposes:`
 *      line: open runs (decorated by the CALLER via WarroomRunstate.run_state,
 *      never recomputed here), idle/next_fire, chips, registry provenance.
 *   2. The job-registry PROJECTION this card is allowed to own (job_id,
 *      display_name, schedule, owner_script, group) — via a single named
 *      adapter reading agents-manifest.json, because WARROOM-AGENTLIB-001
 *      (the agent-side registry) has NOT shipped as of this build. Confirmed
 *      absent: no `AGENTLIB` reference anywhere in DONE_LOG.md or this repo's
 *      lib/scripts this session. registry_source is stamped 'manifest_adapter'
 *      everywhere this module emits provenance, per the card's own instruction
 *      ("the close-out records registry_source=manifest_adapter so the swap
 *      is one function, not a rewrite").
 *   3. The nine-token chip state machine (card CONSTRAINTS: "borrowed, not
 *      invented" — WARROOM-HEALTH-001's seven plus RUNSTATE-001's running/
 *      stuck overlay) with grey meaning `retired` and nothing else.
 *   4. The stream-liveness state machine — the card's own "single most
 *      important property": pulse is DERIVED from stream.alive, never an
 *      independently settable field, enforced by construction (not by
 *      convention) so `{alive:false, pulse:true}` cannot exist as an object.
 *
 * Explicitly NOT this module's job (owned elsewhere, per the card's own
 * dependency list — reused, never recomputed):
 *   - run_state() itself                          -> WarroomRunstate (RUNSTATE-001)
 *   - cron-field parsing / slot expansion          -> WarroomOpsSchedule (OPSTIMELINE-001,
 *     reused here for next_fire so this module does not fork a second cron
 *     parser — C6)
 *   - ET rendering / age / clock-skew detection    -> WarroomClock (CLOCK-001)
 *   - C2 string formatting                         -> WarroomRender (RENDER-001)
 *   - alert delivery                                -> WARROOM-ALERT-001 (this module
 *     only emits alert-shaped *inputs* — {rule_id, provenance_id, severity:
 *     null, ...} — it never writes to an alerts table or Slack itself)
 *
 * BLOCKED at build time, recorded here rather than stubbed (forward-dependency
 * audit's own instruction: "it does not stub the contract locally"):
 *   - WARROOM-FRESHNESS-001's evaluateFreshness() does not exist anywhere in
 *     this repo (confirmed by grep this session; DONE_LOG's WARROOM-DAILY-001
 *     maintainer pass independently confirms the same absence). The C4
 *     "is ops.run_log itself fresh" gate therefore takes its cadence via an
 *     INJECTED `runLogCadenceMs` argument (single call site below,
 *     computeRunLogFreshness()) rather than reading a registry that doesn't
 *     exist. Callers that have no real cadence to inject MUST pass null,
 *     which renders `freshness_source: 'BLOCKED — evaluateFreshness() not built'`
 *     and disables the STALE branch (never silently assumes fresh).
 *   - Decision Gates 1 (§5c cadence), 2 (§5d alert delivery), 3 (heartbeat
 *     add/derive/endpoint) are Shiv-only. resolveCadenceStrategy() ships
 *     inert per the card's explicit instruction ("the panel refuses to start
 *     rather than quietly adopting one option's cadence").
 *
 * Dual-environment (CommonJS + global), the house style of every sibling
 * lib module in this repo.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./warroom-clock.js'), require('./warroom-ops-schedule.js'));
  } else {
    root.WarroomNowPlane = factory(root.WarroomClock, root.WarroomOpsSchedule);
  }
})(typeof self !== 'undefined' ? self : this, function (WarroomClock, WarroomOpsSchedule) {
  'use strict';

  // ---------------------------------------------------------------------
  // 1. Registry projection — manifest_adapter (single call site).
  // ---------------------------------------------------------------------

  var REGISTRY_SOURCE = 'manifest_adapter'; // stamped verbatim into every emission below

  // A schedule string counts as a parseable cron expression only if it is
  // exactly 5 whitespace-separated fields (min hour dom mon dow). launchd
  // descriptors ("StartInterval=300", "KeepAlive=true", free prose like
  // "always-on Railway service...") do NOT match and correctly fall through
  // to "no schedule in registry" (C1) rather than being guessed at.
  function _looksLikeCron(s) {
    return typeof s === 'string' && s.trim().split(/\s+/).length === 5;
  }

  /**
   * loadRegistryFromManifest(manifestJson) -> {
   *   version, generated_at, job_count, source: 'manifest_adapter',
   *   jobs: { [job_id]: {job_id, display_name, schedule, cron, hasCron,
   *                       owner_script, group, expected_cadence_seconds} }
   * }
   *
   * THE single named call site this card's Phase-2 constraint requires — no
   * other function in this module reads agents-manifest.json directly.
   */
  function loadRegistryFromManifest(manifestJson) {
    var m = manifestJson || {};
    var agents = Array.isArray(m.agents) ? m.agents : [];
    var jobs = {};
    agents.forEach(function (a) {
      if (!a || !a.name) return;
      var schedule = typeof a.schedule === 'string' ? a.schedule : null;
      var isCron = _looksLikeCron(schedule);
      jobs[a.name] = {
        job_id: a.name,
        display_name: a.name,
        schedule: schedule,               // raw string, always preserved verbatim
        cron: isCron ? schedule : null,    // only the parseable subset feeds next_fire
        owner_script: a.owner_script || null,
        group: a.type === 'subagent' ? 'subagent' : 'live', // per sasmaster-war-room §6 taxonomy this adapter can see
        expected_cadence_seconds: (a.liveness && typeof a.liveness.max_staleness_s === 'number')
          ? a.liveness.max_staleness_s : null
      };
    });
    return {
      version: m.version || null,
      generated_at: m.generated_at || null,
      job_count: agents.length,
      source: REGISTRY_SOURCE,
      jobs: jobs
    };
  }

  // ---------------------------------------------------------------------
  // 2. next_fire — reuses WarroomOpsSchedule's cron expander (C6: one cron
  //    parser, not a second one). Looks at today's ET slots and, if none
  //    remain today, tomorrow's (the expander is bounded to one ET calendar
  //    day per its own contract, so the wrap is done here by calling it
  //    twice with `now` shifted +24h — no new field-parsing logic added).
  // ---------------------------------------------------------------------

  function _toScheduleShape(reg) {
    var out = {};
    Object.keys(reg.jobs).forEach(function (jid) {
      var j = reg.jobs[jid];
      out[jid] = {
        job_id: j.job_id, display_name: j.display_name, cron: j.cron,
        expected_cadence_seconds: j.expected_cadence_seconds
      };
    });
    return out;
  }

  /**
   * computeNextFire(job_id, registry, now) ->
   *   {job_id, at: <ET display string>, at_utc_iso, in: <duration string>}
   *   | {state: 'N/A — no schedule in registry'}
   *
   * `now` is an injected Date (C5) — this function performs no ambient clock
   * read. Every rendered time goes through WarroomClock.toEt(); every
   * duration is derived from millisecond math on the SAME two instants
   * (scheduled slot vs now), never a second independent clock call.
   */
  function computeNextFire(job_id, registry, now) {
    var reg = registry || { jobs: {} };
    var job = reg.jobs[job_id];
    if (!job || !job.cron) {
      return { state: 'N/A — no schedule in registry' };
    }
    var scheduleShape = _toScheduleShape(reg);
    var nowMs = now.getTime();
    var todaySlots = WarroomOpsSchedule.expandSlotsForWindow(scheduleShape, 24, now)
      .filter(function (s) { return s.job_id === job_id && s.scheduled_at && Date.parse(s.scheduled_at) > nowMs; });
    var candidate = todaySlots[0];
    if (!candidate) {
      // Nothing left today — check tomorrow's ET calendar day by shifting the
      // reference instant forward 24h (same expander, same cron field, no
      // new parsing logic — just a different `now` anchor).
      var tomorrowNow = new Date(nowMs + 24 * 3600000);
      var tomorrowSlots = WarroomOpsSchedule.expandSlotsForWindow(scheduleShape, 24, tomorrowNow)
        .filter(function (s) { return s.job_id === job_id && s.scheduled_at; });
      candidate = tomorrowSlots[0];
    }
    if (!candidate) {
      return { state: 'N/A — no schedule in registry' };
    }
    var atMs = Date.parse(candidate.scheduled_at);
    if (atMs <= nowMs) {
      // A "next fire" that is not actually in the future relative to `now`
      // is a computation defect (the filter above should have excluded it)
      // — surfaced as clock skew (C5) rather than a silently wrong "in -3m".
      return { state: 'ERROR — clock skew' };
    }
    // toEtFuture, not toEt: this timestamp is legitimately future (a
    // computed schedule slot), so it must not trip toEt()'s clock-skew gate,
    // which exists for events that claim to have already happened.
    var etRendered = WarroomClock.toEtFuture(candidate.scheduled_at, now);
    if (etRendered.state === 'error') {
      return { state: 'ERROR — clock skew' };
    }
    var diffMs = atMs - nowMs;
    var diffMin = Math.round(diffMs / 60000);
    var inStr = diffMin < 60 ? (diffMin + 'm')
      : (Math.floor(diffMin / 60) + 'h ' + (diffMin % 60) + 'm');
    return {
      job_id: job_id,
      at: etRendered.display,
      at_utc_iso: candidate.scheduled_at,
      in: inStr
    };
  }

  // ---------------------------------------------------------------------
  // 3. Stream-liveness — the cardinal mechanism. Pulse is DERIVED, never a
  //    settable field: pulseActive() is the ONLY producer, and makeFrame()
  //    throws on construction if handed an inconsistent pair. This is what
  //    the card's VERIFY step asserts as "not constructible" via a thrown
  //    invariant rather than an absent screenshot.
  // ---------------------------------------------------------------------

  /**
   * pulseActive(streamAlive) -> boolean. The only function anywhere in this
   * module (or intended to be called from the render layer) allowed to
   * decide whether the pulse animates. Never set the pulse attribute from
   * anything else.
   */
  function pulseActive(streamAlive) {
    return streamAlive === true;
  }

  /**
   * makeStreamFrame({alive, lastBeatAt, beatsMissed, declaredDeadAfterMs, now})
   * -> {alive, pulse, lastBeatAt, beatsMissed, declaredDeadAfterMs, beatAgeMs}
   *
   * THROWS if called with an explicit `pulse` field that disagrees with
   * pulseActive(alive) — this is the structural-impossibility assertion the
   * card's VERIFY step requires: "a state with stream.alive == false AND an
   * active pulse is not constructible" is asserted here as a thrown
   * TypeError, not merely as "the render happens to never do that".
   */
  function makeStreamFrame(input) {
    input = input || {};
    var alive = input.alive === true;
    var derivedPulse = pulseActive(alive);
    if (Object.prototype.hasOwnProperty.call(input, 'pulse') && input.pulse !== derivedPulse) {
      throw new TypeError(
        'makeStreamFrame: pulse must equal pulseActive(alive) — got alive=' + alive +
        ' pulse=' + input.pulse + '. The pulse dot is bound to stream liveness only; ' +
        'it is never an independently settable field (card\'s cardinal invariant).'
      );
    }
    var beatAge = null;
    if (input.lastBeatAt != null && input.now != null) {
      var a = WarroomClock.ageFrom(input.lastBeatAt, input.now);
      beatAge = a.state === 'ok' ? a.ms : null; // clock-skew on a beat timestamp -> unknown age, never 0
    }
    return Object.freeze({
      alive: alive,
      pulse: derivedPulse,
      lastBeatAt: input.lastBeatAt != null ? input.lastBeatAt : null,
      beatAgeMs: beatAge,
      beatsMissed: typeof input.beatsMissed === 'number' ? input.beatsMissed : null,
      declaredDeadAfterMs: typeof input.declaredDeadAfterMs === 'number' ? input.declaredDeadAfterMs : null
    });
  }

  /**
   * createLivenessTracker({heartbeatIntervalMs, missedBeatsThreshold}) ->
   *   { recordBeat(now), evaluate(now) -> streamFrame }
   *
   * heartbeatIntervalMs (`I`) and missedBeatsThreshold (`N`) are ALWAYS
   * injected by the caller — this module never guesses 25000/3 as defaults.
   * This session measured I=25000ms empirically (two consecutive `: heartbeat`
   * SSE comment lines at t=25.520s and t=50.525s against
   * api.sasmaster.dev/api/events/stream, delta=25.005s) — that measured value,
   * not the doc's claimed 25s, is what a caller should pass, per the card's
   * own instruction. N is Decision-Gate-3 territory and is NOT defaulted here.
   */
  function createLivenessTracker(config) {
    config = config || {};
    var I = config.heartbeatIntervalMs;
    var N = config.missedBeatsThreshold;
    if (typeof I !== 'number' || I <= 0 || typeof N !== 'number' || N <= 0) {
      throw new TypeError('createLivenessTracker requires numeric heartbeatIntervalMs and missedBeatsThreshold — Gate 3 is unresolved and this module refuses to default them.');
    }
    var lastBeatAt = null; // null = never connected this session -> "N/A — no beat received", never 0s
    return {
      recordBeat: function (now) {
        lastBeatAt = (now instanceof Date ? now : new Date(now)).toISOString();
      },
      evaluate: function (now) {
        if (lastBeatAt == null) {
          return makeStreamFrame({ alive: false, lastBeatAt: null, beatsMissed: null, declaredDeadAfterMs: N * I, now: now });
        }
        var age = WarroomClock.ageFrom(lastBeatAt, now);
        if (age.state === 'error') {
          // clock skew on the beat timestamp itself — never assert liveness off a broken clock
          return makeStreamFrame({ alive: false, lastBeatAt: lastBeatAt, beatsMissed: null, declaredDeadAfterMs: N * I, now: now });
        }
        var beatsMissed = Math.floor(age.ms / I);
        var alive = age.ms < N * I;
        return makeStreamFrame({
          alive: alive, lastBeatAt: lastBeatAt, beatsMissed: beatsMissed,
          declaredDeadAfterMs: N * I, now: now
        });
      }
    };
  }

  // ---------------------------------------------------------------------
  // 4. Chip state machine — nine borrowed tokens (WARROOM-HEALTH-001's
  //    seven + RUNSTATE-001's running/stuck overlay), grey means retired
  //    and nothing else, unknown/query-failure renders ERROR — never grey,
  //    never green, never the previous frame's value.
  // ---------------------------------------------------------------------

  var CHIP_STATES = {
    HEALTHY: 'healthy', LATE: 'late', STALE: 'stale', FAILED: 'failed',
    BLOCKED: 'blocked', RETIRED: 'retired', NEVER_RUN: 'never_run',
    RUNNING: 'running', STUCK: 'stuck'
  };

  var CHIP_LEGEND = [
    { state: CHIP_STATES.HEALTHY, meaning: 'Last run in this job\'s registered window, succeeded.' },
    { state: CHIP_STATES.LATE, meaning: 'Past its expected cadence, not yet past the stale threshold.' },
    { state: CHIP_STATES.STALE, meaning: 'Past 2x its declared cadence with no fresh terminal record.' },
    { state: CHIP_STATES.FAILED, meaning: 'Most recent terminal record has a non-zero exit code.' },
    { state: CHIP_STATES.BLOCKED, meaning: 'Known upstream dependency prevented this run.' },
    { state: CHIP_STATES.RETIRED, meaning: 'Job is deliberately no longer scheduled — the ONLY state grey renders.' },
    { state: CHIP_STATES.NEVER_RUN, meaning: 'Registered, but ops.run_log holds no record for it.' },
    { state: CHIP_STATES.RUNNING, meaning: 'Open run_log row, within its p95-derived threshold.' },
    { state: CHIP_STATES.STUCK, meaning: 'Open run_log row, past 2x its p95 threshold.' }
  ];

  var GREEN_STATES = { healthy: true, running: true };

  /**
   * computeChipState(input) -> {job_id, state, colorToken, reason?, queryId?}
   * input: {job_id, retired: bool, runState: <object from WarroomRunstate.run_state()>,
   *         readError: bool, queryId: string}
   *
   * Single evaluation, one function — feeds BOTH the rendered chip AND the
   * alert-input row for non-green states (§2.2 discipline, "the alert must
   * fire from the same evaluation that colors the tile").
   */
  function computeChipState(input) {
    input = input || {};
    if (input.readError) {
      return {
        job_id: input.job_id, state: 'error', colorToken: 'error',
        reason: 'ERROR — ' + (input.queryId || input.job_id || 'chip_query'),
        queryId: input.queryId || null
      };
    }
    if (input.retired) {
      return { job_id: input.job_id, state: CHIP_STATES.RETIRED, colorToken: 'grey', reason: null };
    }
    var rs = input.runState;
    if (!rs) {
      return { job_id: input.job_id, state: CHIP_STATES.NEVER_RUN, colorToken: 'error', reason: 'N/A — never run' };
    }
    // Map WarroomRunstate's own vocabulary onto the card's nine chip tokens,
    // never re-deriving running/stuck/succeeded/failed independently (C6).
    var map = {
      succeeded: CHIP_STATES.HEALTHY,
      failed: CHIP_STATES.FAILED,
      running: CHIP_STATES.RUNNING,
      stuck: CHIP_STATES.STUCK,
      never_run: CHIP_STATES.NEVER_RUN,
      stale: CHIP_STATES.STALE,
      na_insufficient_history: CHIP_STATES.RUNNING, // still an open run, bootstrap-gated on STUCK only
      error: 'error'
    };
    var state = map[rs.state] || 'error';
    var colorToken = state === 'error' ? 'error' : (GREEN_STATES[state] ? 'green' : (state === CHIP_STATES.RETIRED ? 'grey' : 'amber'));
    return {
      job_id: input.job_id, state: state, colorToken: colorToken,
      reason: rs.reason || null, runId: rs.run_id || null
    };
  }

  // ---------------------------------------------------------------------
  // 5. Registry-driven alert input: a run_log job absent from the registry.
  // ---------------------------------------------------------------------

  function findUnregisteredJobs(runLogJobIds, registry) {
    var reg = registry || { jobs: {} };
    var out = [];
    (runLogJobIds || []).forEach(function (j) {
      if (!reg.jobs[j]) out.push(j);
    });
    return out;
  }

  // ---------------------------------------------------------------------
  // 6. Idle / STALE / open-runs composition — now_plane() itself.
  // ---------------------------------------------------------------------

  /**
   * computeRunLogFreshness(runLogCadenceMs, lastRunLogWriteIso, now) ->
   *   {fresh: bool|null, source: 'injected'|'BLOCKED — evaluateFreshness() not built'}
   *
   * runLogCadenceMs is ALWAYS caller-injected (never a default here). If the
   * caller passes null (the honest state, since WARROOM-FRESHNESS-001's
   * evaluateFreshness() does not exist in this repo — confirmed absent this
   * session), freshness cannot be evaluated at all: fresh:null, source
   * BLOCKED. A null fresh value must NEVER be treated as "fresh" upstream.
   */
  function computeRunLogFreshness(runLogCadenceMs, lastRunLogWriteIso, now) {
    if (typeof runLogCadenceMs !== 'number' || runLogCadenceMs <= 0 || !lastRunLogWriteIso) {
      return { fresh: null, source: 'BLOCKED — evaluateFreshness() not built' };
    }
    var age = WarroomClock.ageFrom(lastRunLogWriteIso, now);
    if (age.state === 'error') return { fresh: null, source: 'injected', ageError: 'clock skew' };
    return { fresh: age.ms <= runLogCadenceMs * 2, source: 'injected', ageMs: age.ms };
  }

  /**
   * now_plane(input) -> the card's `exposes:` contract shape.
   *
   * input:
   *   openRunStates    array of {job_id, run_id, started_at, finished_at:null,
   *                     ...run_state() output already computed by caller — C6,
   *                     never recomputed here}
   *   registry         from loadRegistryFromManifest()
   *   runLogCadenceMs  see computeRunLogFreshness — null if unavailable
   *   lastRunLogWriteIso  the run-log's own most recent write timestamp, for
   *                     the C4 "is ops.run_log itself alive" gate
   *   streamFrame      from createLivenessTracker().evaluate()
   *   allRunLogJobIds  every distinct job seen in ops.run_log this evaluation
   *                     (for unregistered_job + chip enumeration)
   *   chipInputsByJob  map job_id -> {retired, runState, readError, queryId}
   *   now              injected Date (C5)
   *   queryId          the run-log query id this evaluation used
   */
  function now_plane(input) {
    input = input || {};
    var registry = input.registry || { jobs: {}, job_count: 0, version: null, generated_at: null, source: REGISTRY_SOURCE };
    var now = input.now;
    var openRunStates = input.openRunStates || [];

    var freshness = computeRunLogFreshness(input.runLogCadenceMs, input.lastRunLogWriteIso, now);

    var idle, next_fire = null, stale = null;
    if (openRunStates.length === 0) {
      if (freshness.fresh === false) {
        idle = false;
        stale = { state: 'STALE ' + (freshness.ageMs != null ? Math.round(freshness.ageMs / 60000) + 'm' : '') };
      } else if (freshness.fresh === null) {
        // C4 input blocked — the honest render is neither a confident IDLE
        // nor a confident STALE; the panel must say which is unknown and why.
        idle = false;
        stale = { state: 'N/A — run-log freshness unknown (freshness_source=' + freshness.source + ')' };
      } else {
        idle = true;
        // next_fire = earliest across the whole registry, per C1's
        // "no fabricated currency" — computed per job, then the minimum kept.
        var best = null;
        Object.keys(registry.jobs).forEach(function (jid) {
          var nf = computeNextFire(jid, registry, now);
          if (nf.state) return; // unparseable/absent schedule for this job — excluded, not guessed
          if (!best || Date.parse(nf.at_utc_iso) < Date.parse(best.at_utc_iso)) best = nf;
        });
        next_fire = best || { state: 'N/A — no schedule in registry' };
      }
    } else {
      idle = false;
    }

    var chips = [];
    if (input.chipInputsByJob) {
      Object.keys(input.chipInputsByJob).forEach(function (jid) {
        var c = computeChipState(Object.assign({ job_id: jid }, input.chipInputsByJob[jid]));
        chips.push(c);
      });
    }

    var unregistered = findUnregisteredJobs(input.allRunLogJobIds || [], registry);

    return {
      stream: input.streamFrame || null,
      open_runs: openRunStates,
      idle: idle,
      stale: stale,
      next_fire: next_fire,
      chips: chips,
      unregistered_jobs: unregistered,
      registry: {
        version: registry.version, generated_at: registry.generated_at,
        job_count: registry.job_count, source: registry.source || REGISTRY_SOURCE
      },
      freshness: freshness,
      source_age: freshness.ageMs != null ? freshness.ageMs : null,
      query_id: input.queryId || null
    };
  }

  // ---------------------------------------------------------------------
  // 7. Decision Gate 1 — cadence resolver. Ships INERT per the card's own
  //    instruction: no default cadence is active until Shiv rules. Any
  //    caller trying to actually run the panel off this must see refusal,
  //    not a silently adopted default.
  // ---------------------------------------------------------------------

  function resolveCadenceStrategy() {
    return {
      active: false,
      reason: 'DECISION GATE 1 (§5c SSE vs poll vs hybrid) unresolved — reserved to Shiv. ' +
        'This resolver intentionally ships with no default active; the panel refuses to start ' +
        'on a live cadence until this is ruled.'
    };
  }

  return {
    REGISTRY_SOURCE: REGISTRY_SOURCE,
    CHIP_STATES: CHIP_STATES,
    CHIP_LEGEND: CHIP_LEGEND,
    loadRegistryFromManifest: loadRegistryFromManifest,
    computeNextFire: computeNextFire,
    pulseActive: pulseActive,
    makeStreamFrame: makeStreamFrame,
    createLivenessTracker: createLivenessTracker,
    computeChipState: computeChipState,
    findUnregisteredJobs: findUnregisteredJobs,
    computeRunLogFreshness: computeRunLogFreshness,
    now_plane: now_plane,
    resolveCadenceStrategy: resolveCadenceStrategy
  };
});
