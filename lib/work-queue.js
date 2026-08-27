/**
 * WARROOM-WORKQUEUE-001 — the one work_queue model (C6).
 *
 * CANVAS, AGENTS, QUEUE, and OPS render PROJECTIONS of one array this module
 * builds — never four independent lists. Item shape (card's own C6 line):
 *   { item_id, kind, subject, opened_at, age_days, escalation_state, owner,
 *     actions, source_query }
 * kind in: 'bless' | 'blocked_agent' | 'review' | 'ops_task'
 *
 * DECISION GATE (escalation cadence, ruled by Shiv 2026-08-26, recorded in
 * warroom/cadence-registry.json's `queue_kinds` block): derive from each
 * kind's own source cadence. No source declares one for any of the 4 kinds
 * today (`expected_cadence_seconds: null` for all four) — so
 * computeEscalation() below is the parameterised comparison the ruling asks
 * for, with NO threshold filled in (C3: never a guessed number). Every item
 * renders `escalation_state: 'unset'` / `N/A — cadence undeclared` until a
 * future pass names a real cadence in that registry — this module reads
 * whatever is there and does not choose a number itself.
 *
 * C1: counts are never fabricated. Each kind's item list length IS the count
 * — there is no separate "6 pending" computation anywhere in this module.
 * C2 (four render states): a kind whose source query itself failed (S3
 * fetch, health evaluator throwing) is reported via `kindStatus[kind] =
 * {state:'error', query_id, reason}` — the caller renders `ERROR — <query_id>`
 * for that kind's header, NEVER a fabricated `0` (a zero is a positive claim
 * "we looked, there are none" that a failed lookup cannot make).
 * C5: age is `date_diff('day', opened_at, now)` — calendar-day diff against
 * a `now` the caller passes in (WarroomClock.nowUtc() elsewhere) — no stored
 * anchor, ages forward on every call with no rebuild.
 * C7: blocked-agent subjects come ONLY from the agent's own `healthEval`
 * object (the already-built §2.1 evaluator's structured output) — never by
 * regexing `lastOutput`/log prose. This module does not implement or patch
 * that evaluator (WARROOM-HEALTH-001 owns it) — it consumes its result.
 *
 * Dual-environment (CommonJS for api/work-queue.js + tests, global for
 * warroom-v5.html), same house pattern as lib/warroom-clock.js /
 * lib/warroom-render.js (C6 — one convention, not a second one).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.WorkQueue = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var KINDS = ['bless', 'blocked_agent', 'review', 'ops_task'];

  // Internal Slack channel ids that must never reach a rendered row (§2.5).
  // Resolved to a human name; an id not in this map is OMITTED, never printed
  // raw — the card's own rule ("resolves to a human name or is omitted").
  var CHANNEL_NAMES = { C0ATABZAH39: '#sasmaster-builds' };

  function _utcDateOnlyMs(d) {
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  }

  // ageDays(openedAtIso, now) -> integer | null. Calendar-day diff, matching
  // the card's own VERIFY assertion shape: `date_diff('day', X, current_date)`.
  function ageDays(openedAtIso, now) {
    if (!openedAtIso) return null;
    var o = new Date(openedAtIso);
    if (isNaN(o.getTime())) return null;
    var n = now instanceof Date ? now : new Date(now);
    return Math.round((_utcDateOnlyMs(n) - _utcDateOnlyMs(o)) / 86400000);
  }

  // computeEscalation(ageDaysVal, cadenceSeconds) -> {state, display}
  // The comparison function the DECISION GATE asks for — written and
  // parameterised, thresholds NOT filled in (per the ruling: no source names
  // a cadence for any of the 4 kinds yet). C4: exceeding cadence*2 -> STALE.
  function computeEscalation(ageDaysVal, cadenceSeconds) {
    if (cadenceSeconds == null) {
      return { state: 'unset', display: 'N/A — cadence undeclared' };
    }
    if (ageDaysVal == null) {
      return { state: 'unset', display: 'N/A — age unknown' };
    }
    var cadenceDays = cadenceSeconds / 86400;
    if (ageDaysVal > cadenceDays * 2) return { state: 'stale', display: 'STALE ' + ageDaysVal + 'd' };
    if (ageDaysVal > cadenceDays) return { state: 'escalated', display: 'ESCALATED ' + ageDaysVal + 'd' };
    return { state: 'ok', display: ageDaysVal + 'd' };
  }

  // Resolves a Slack channel id embedded in a raw OPS log line to a human
  // name, or null (omitted) — never the raw id (§2.5).
  function resolveChannel(channelId) {
    if (!channelId) return null;
    return CHANNEL_NAMES[channelId] || null;
  }

  // Pulls the free-text tail out of the `task_id:X | ts:Y | channel:Z |
  // status:W | created_at:V | tag:T | <description>` raw line shape WITHOUT
  // re-including any key:value field (so it can never leak the channel id
  // even if a future field is added to the raw format). Returns null if the
  // line carries no free-text segment.
  function _opsFreeText(fullText) {
    var parts = String(fullText || '').split('|').map(function (s) { return s.trim(); });
    var free = parts.filter(function (p) { return p && !/^[a-zA-Z_]+:/.test(p); });
    return free.length ? free.join(' — ') : null;
  }

  /**
   * buildBlessItems(catalog, now) -> {items, kindStatus}
   * catalog: {ok:true, entries:[{certified_id,query,built_at,status}]} |
   *          {ok:false, query_id, reason}
   */
  function buildBlessItems(catalog, now) {
    if (!catalog || catalog.ok !== true) {
      return {
        items: [],
        kindStatus: { state: 'error', query_id: (catalog && catalog.query_id) || 'bless-catalog-fetch-failed', reason: (catalog && catalog.reason) || 'catalog fetch failed' }
      };
    }
    var pending = (catalog.entries || []).filter(function (e) { return e && e.status === 'pending'; });
    var items = pending.map(function (e) {
      var opened = e.built_at || null;
      return {
        item_id: 'bless:' + (e.certified_id || e.query || 'unknown'),
        kind: 'bless',
        subject: e.query || '(untitled artifact)',
        opened_at: opened,
        age_days: ageDays(opened, now),
        escalation_state: null, // filled by caller with the shared cadence lookup
        owner: 'catalog',
        actions: ['bless', 'redirect', 'kill'],
        source_query: 's3://sasmaster-public/catalog/index.json (status=pending)'
      };
    });
    return { items: items, kindStatus: { state: 'ok', count: items.length } };
  }

  /**
   * buildBlockedAgentItems(agents, now) -> {items, kindStatus}
   * agents: status.json's `agents` array (each carries `healthEval` from the
   * already-built §2.1 evaluator). 'na' entries are on-demand/subagents,
   * excluded from schedule evaluation entirely (§5b denominator untouched —
   * this function reads it, never recomputes it).
   */
  function buildBlockedAgentItems(agents, now) {
    var scheduleEvaluated = (agents || []).filter(function (a) {
      return a && a.healthEval && a.healthEval.state !== 'na';
    });
    var erroredCount = scheduleEvaluated.filter(function (a) { return a.healthEval.state === 'error'; }).length;
    var blocked = scheduleEvaluated.filter(function (a) { return a.healthEval.state === 'blocked'; });

    if (blocked.length === 0 && erroredCount > 0) {
      // The §2.1 evaluator itself could not classify ANY schedule-evaluated
      // agent this cycle (e.g. GATE-A's agentStaleMult/feedStaleMult unset —
      // see generate-status.js AGENT_STALE_MULT/FEED_STALE_MULT). A confirmed
      // zero would assert "no agent is blocked", which this evaluation cannot
      // support — C2 requires ERROR here, not a fabricated real-zero.
      return {
        items: [],
        kindStatus: {
          state: 'error',
          query_id: 'health-eval-gate-unresolved',
          reason: erroredCount + ' of ' + scheduleEvaluated.length + ' schedule-evaluated agents returned healthEval.state=error — the evaluator cannot distinguish blocked from healthy from stale until its own gate is resolved (WARROOM-HEALTH-001)'
        }
      };
    }

    var items = blocked.map(function (a) {
      var opened = (a.healthEval.inputs && a.healthEval.inputs.last_run) || a.lastRun || null;
      return {
        item_id: 'blocked_agent:' + a.name,
        kind: 'blocked_agent',
        subject: 'blocked — ' + (a.healthEval.reason || 'awaiting input') + (ageDays(opened, now) != null ? ' (' + ageDays(opened, now) + 'd)' : ''),
        opened_at: opened,
        age_days: ageDays(opened, now),
        escalation_state: null,
        owner: a.name,
        actions: ['unblock'],
        source_query: 'status.json:agents[].healthEval (§2.1 evaluator)'
      };
    });
    return { items: items, kindStatus: { state: 'ok', count: items.length } };
  }

  /**
   * buildReviewItems(reviewRows, now) -> {items, kindStatus}
   * reviewRows: status.json's kanban.review array, each optionally carrying
   * `openedAt` (added to generate-status.js's parsePending()/reviewItems this
   * card — a review row with no openedAt yet is honestly age-unknown, not a
   * guessed date, until status.json is next regenerated).
   */
  function buildReviewItems(reviewRows, now) {
    var items = (reviewRows || []).map(function (r) {
      var opened = r.openedAt || (r.meta && r.meta.opened) || null;
      return {
        item_id: 'review:' + (r.id || r.approvalId || r.text),
        kind: 'review',
        subject: r.text || r.full || '(untitled review item)',
        opened_at: opened,
        age_days: ageDays(opened, now),
        escalation_state: null,
        owner: 'shiv',
        actions: [],
        source_query: 'SaSMaster/pending-approvals.json + TASKS.md [REVIEW] via status.json:kanban.review'
      };
    });
    return { items: items, kindStatus: { state: 'ok', count: items.length } };
  }

  /**
   * buildOpsTaskItems(highItems, now) -> {items, kindStatus}
   * highItems: status.json's queue.highItems (TASKS.md `[HIGH]` rows).
   * Every row is routed through the typed parse (channel dropped, never
   * rendered) before it becomes a subject string — §2.5.
   */
  function buildOpsTaskItems(highItems, now, formatOpsQueueItem, renderStates) {
    var items = (highItems || []).map(function (item) {
      var rawText = item.full || item.text || '';
      var parsed = formatOpsQueueItem(rawText, item.id || 'ops-item');
      var subject, opened;
      if (parsed.state === renderStates.ERROR) {
        subject = 'ERROR — ' + parsed.query_id;
        opened = null;
      } else if (parsed.value && parsed.value.task_id) {
        var freeText = _opsFreeText(rawText);
        subject = parsed.value.task_id + (freeText ? ' — ' + freeText : '') + ' — ' + parsed.value.status;
        opened = parsed.value.created_at || null;
      } else {
        subject = (parsed.value && parsed.value.plain_text) || rawText.slice(0, 120);
        opened = null;
      }
      return {
        item_id: 'ops_task:' + (item.id || item.lineIndex),
        kind: 'ops_task',
        subject: subject,
        opened_at: opened,
        age_days: ageDays(opened, now),
        escalation_state: null,
        owner: item.tag || 'INFRA',
        actions: ['diagnose'],
        source_query: 'SaSMaster/TASKS.md [HIGH] via status.json:queue.highItems'
      };
    });
    return { items: items, kindStatus: { state: 'ok', count: items.length } };
  }

  /**
   * assemble(input) -> {items, kindStatus, generated_at}
   * input:
   *   now                 Date
   *   catalog             see buildBlessItems
   *   agents              status.json.agents
   *   reviewRows          status.json.kanban.review
   *   highItems           status.json.queue.highItems
   *   cadenceRegistry     warroom/cadence-registry.json (queue_kinds block)
   *   formatOpsQueueItem  WarroomRender.formatOpsQueueItem (C6 — no reimpl)
   *   renderStates        WarroomRender.STATE
   */
  function assemble(input) {
    var now = input.now instanceof Date ? input.now : new Date(input.now || Date.now());
    var cadenceByKind = (input.cadenceRegistry && input.cadenceRegistry.queue_kinds) || {};

    var bless = buildBlessItems(input.catalog, now);
    var blockedAgent = buildBlockedAgentItems(input.agents, now);
    var review = buildReviewItems(input.reviewRows, now);
    var opsTask = buildOpsTaskItems(input.highItems, now, input.formatOpsQueueItem, input.renderStates);

    var byKind = { bless: bless, blocked_agent: blockedAgent, review: review, ops_task: opsTask };
    var allItems = [];
    var kindStatus = {};

    KINDS.forEach(function (kind) {
      var built = byKind[kind];
      var cadenceSeconds = cadenceByKind[kind] ? cadenceByKind[kind].expected_cadence_seconds : null;
      built.items.forEach(function (it) {
        var esc = computeEscalation(it.age_days, cadenceSeconds);
        it.escalation_state = esc.state;
        it.escalation_display = esc.display;
        allItems.push(it);
      });
      kindStatus[kind] = built.kindStatus;
    });

    // Default sort: age descending (oldest decision first, card's 🟢 rule).
    // Items with unknown age (null) sort after known ages, not before —
    // an unknown fact is not "oldest", it is unknown.
    allItems.sort(function (a, b) {
      if (a.age_days == null && b.age_days == null) return 0;
      if (a.age_days == null) return 1;
      if (b.age_days == null) return -1;
      return b.age_days - a.age_days;
    });

    return { items: allItems, kindStatus: kindStatus, generated_at: now.toISOString() };
  }

  return {
    KINDS: KINDS,
    ageDays: ageDays,
    computeEscalation: computeEscalation,
    resolveChannel: resolveChannel,
    buildBlessItems: buildBlessItems,
    buildBlockedAgentItems: buildBlockedAgentItems,
    buildReviewItems: buildReviewItems,
    buildOpsTaskItems: buildOpsTaskItems,
    assemble: assemble
  };
});
