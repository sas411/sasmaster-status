// WARROOM-RENDER-001 — shared four-state tile renderer + typed formatters.
//
// C2: exactly four render states — value | zero | na | error — no bare em-dash
// standing in for a number. Ambiguous blanks ("—") mean null/zero/unavailable/
// error all at once; this module makes the board say which.
//
// Dual-environment like lib/warroom-clock.js: CommonJS export for
// generate-status.js, global window.WarroomRender for warroom-v5.html.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.WarroomRender = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var STATE = { VALUE: 'value', ZERO: 'zero', NA: 'na', ERROR: 'error' };

  // Exported counter for WARROOM-ALERT-001 to consume later (forward
  // dependency — this card only exports it, never wires an alert rule).
  var counters = { unrenderable_event: 0 };
  function incrementUnrenderable() { counters.unrenderable_event += 1; return counters.unrenderable_event; }
  function resetUnrenderableCounter() { counters.unrenderable_event = 0; }

  // C2 payload contract: {value, state, reason?, query_id?, source?, computed_at?}
  function makeValue(value, source, computedAt) {
    return { value: value, state: STATE.VALUE, source: source || null, computed_at: computedAt || null };
  }
  function makeZero(source, computedAt) {
    return { value: 0, state: STATE.ZERO, source: source || null, computed_at: computedAt || null };
  }
  function makeNA(reason, source, computedAt) {
    if (!reason) throw new Error('WarroomRender.makeNA requires a specific reason string (C2)');
    return { value: null, state: STATE.NA, reason: reason, source: source || null, computed_at: computedAt || null };
  }
  function makeError(queryId, source) {
    if (!queryId) throw new Error('WarroomRender.makeError requires a query_id (C2)');
    return { value: null, state: STATE.ERROR, query_id: queryId, source: source || null };
  }

  // Payload-level em-dash gate (runtime assertion, not just static grep —
  // the card requires this operate on the tile PAYLOAD, not page prose).
  // Throws in dev; callers in render code should catch and route to
  // ERROR — unrenderable, never let a bad payload reach the DOM silently.
  var BANNED_VALUES = ['—', '--', '---', ''];
  function assertValidPayload(p) {
    if (!p || typeof p !== 'object') throw new Error('WarroomRender payload must be an object');
    if (!p.state) throw new Error('WarroomRender payload missing state (C2)');
    if ([STATE.VALUE, STATE.ZERO].indexOf(p.state) !== -1 && BANNED_VALUES.indexOf(String(p.value)) !== -1) {
      throw new Error('WarroomRender payload C2 violation: value/zero state carrying an em-dash-class placeholder ("' + p.value + '")');
    }
    if (p.state === STATE.NA && !p.reason) throw new Error('WarroomRender payload C2 violation: na state with no reason');
    if (p.state === STATE.ERROR && !p.query_id) throw new Error('WarroomRender payload C2 violation: error state with no query_id');
    return true;
  }

  // Renders a payload to display text. Four branches only, no fallthrough.
  function renderValue(payload, formatter) {
    assertValidPayload(payload);
    switch (payload.state) {
      case STATE.VALUE:
        return { text: formatter ? formatter(payload.value) : String(payload.value), cls: 'v-value' };
      case STATE.ZERO:
        return { text: formatter ? formatter(0) : '0', cls: 'v-zero' };
      case STATE.NA:
        return { text: 'N/A — ' + payload.reason, cls: 'v-na' };
      case STATE.ERROR:
        return { text: 'ERROR — ' + payload.query_id, cls: 'v-error' };
      default:
        // Unreachable given assertValidPayload, but no silent fallthrough (C2).
        throw new Error('WarroomRender.renderValue: unknown state "' + payload.state + '"');
    }
  }

  // ---- Typed formatters (§2.5) ----
  // Unformattable input never throws past the caller — returns an ERROR
  // payload and increments the exported counter (WARROOM-ALERT-001 consumes
  // the counter later; delivery is not this card's scope).

  // TELEMETRY event: {ts, type, text} -> typed row. Timestamp via toEt/ageFrom
  // (C5) — caller must pass the WarroomClock module in (no reimplementation, C6).
  function formatTelemetryEvent(ev, id, clock) {
    try {
      if (!ev || typeof ev !== 'object') throw new Error('not an object');
      var subject = String(ev.text != null ? ev.text : '').trim();
      var type = String(ev.type || 'EVENT').toUpperCase().substring(0, 7);
      if (!ev.ts) {
        return { state: STATE.ERROR, query_id: 'telemetry-event-' + id, reason: 'no canonical timestamp' };
      }
      var et = clock.toEt(ev.ts);
      if (et.state === 'error') {
        return { state: STATE.ERROR, query_id: 'telemetry-event-' + id, reason: et.reason || 'clock skew' };
      }
      return { state: STATE.VALUE, value: { type: type, subject: subject.substring(0, 60), et_display: et.display } };
    } catch (e) {
      incrementUnrenderable();
      return { state: STATE.ERROR, query_id: 'unrenderable-event-' + id, reason: e.message };
    }
  }

  // OPS queue item: parses the raw `task_id:X | ts:Y | channel:Z | status:W |
  // created_at:V` internal-log-line format that was leaking straight into the
  // DOM (including an internal Slack channel id — a real exposure). channel
  // is DROPPED at parse — never included in the returned payload, never
  // serialized. Falls through to plain-text rendering for ordinary
  // human-authored task lines that don't match this pattern.
  var RAW_LOG_LINE_RE = /task_id:(\S+)\s*\|\s*ts:(\S+)\s*\|\s*channel:(\S+)\s*\|\s*status:(\S+)\s*\|\s*created_at:(\S+)/;
  function formatOpsQueueItem(rawText, id) {
    try {
      var text = String(rawText || '');
      var m = text.match(RAW_LOG_LINE_RE);
      if (m) {
        return {
          state: STATE.VALUE,
          value: { task_id: m[1], ts: m[2], status: m[4], created_at: m[5] } // channel (m[3]) intentionally dropped
        };
      }
      // Ordinary task line — render as plain text, not an error.
      return { state: STATE.VALUE, value: { plain_text: text.substring(0, 120) } };
    } catch (e) {
      incrementUnrenderable();
      return { state: STATE.ERROR, query_id: 'unrenderable-ops-item-' + id, reason: e.message };
    }
  }

  // CANVAS artifact: {title, built_at, state} -> typed. A missing/invalid
  // file is an empty state (with an action), never the raw filename printed
  // as prose content.
  function formatCanvasArtifact(a, id) {
    try {
      if (!a || typeof a !== 'object') {
        return { state: STATE.NA, reason: 'no artifact available', query_id: null };
      }
      if (!a.title) throw new Error('artifact missing title');
      return { state: STATE.VALUE, value: { title: String(a.title), built_at: a.built_at || null, artifact_state: a.state || 'unknown' } };
    } catch (e) {
      incrementUnrenderable();
      return { state: STATE.ERROR, query_id: 'unrenderable-canvas-artifact-' + id, reason: e.message };
    }
  }

  // Thin delegator to WarroomClock.ageFrom — NOT a second age implementation
  // (C6). Replaces the hand-rolled `timeSince()` that lived in warroom-v5.html
  // at 7 call sites, computing its own s/60/3600/86400 buckets independent of
  // WarroomClock, flagged by WARROOM-CLOCK-001's MAINTAINER pass.
  // WARROOM-RENDER-001 remediation (2026-08-24, MAINTAINER gap 7): the two internal fallbacks
  // used to default to a bare '—' when the caller omitted the third argument. Every real call
  // site in warroom-v5.html always passes an explicit fallback string today, so this was
  // dormant, not reachable — but check-clock-gate.sh never scanned this file (also fixed this
  // pass), so a future call site that forgot the third argument would have silently produced a
  // bare em-dash with no static or runtime check catching it (this function returns a plain
  // string, never goes through the C2 payload contract). Default is now a compliant N/A string.
  function formatAge(iso, clock, fallback) {
    var fb = fallback != null ? fallback : 'N/A — no timestamp';
    if (!iso) return fb;
    var a = clock.ageFrom(iso, clock.nowUtc());
    if (a.state === 'error') return fb;
    return a.display;
  }

  return {
    STATE: STATE,
    formatAge: formatAge,
    counters: counters,
    incrementUnrenderable: incrementUnrenderable,
    resetUnrenderableCounter: resetUnrenderableCounter,
    makeValue: makeValue,
    makeZero: makeZero,
    makeNA: makeNA,
    makeError: makeError,
    assertValidPayload: assertValidPayload,
    renderValue: renderValue,
    formatTelemetryEvent: formatTelemetryEvent,
    formatOpsQueueItem: formatOpsQueueItem,
    formatCanvasArtifact: formatCanvasArtifact
  };
});
