/**
 * WARROOM-CLOCK-001 — the one time module (C5).
 *
 * All storage is UTC. All render is America/New_York with the offset shown.
 * A future timestamp (relative to `now`) is a clock-skew defect, never a value.
 * Every rolling window takes `now` as an argument — no stored anchors.
 *
 * Dual-environment (CommonJS for generate-status.js, global for warroom-v5.html
 * inline scripts — this repo has no bundler/module system, confirmed in
 * WARROOM_CLOCK_SITES.md Phase 1).
 */
(function (root) {
  'use strict';

  var TZ = 'America/New_York';

  function nowUtc() {
    return new Date();
  }

  function _isFinite(d) {
    return d instanceof Date && !isNaN(d.getTime());
  }

  function _coerce(ts) {
    if (ts instanceof Date) return ts;
    var d = new Date(ts);
    return d;
  }

  // ICU resolves EST/EDT correctly via the IANA tz database — no manual DST math.
  function _etParts(d) {
    var fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: TZ,
      hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      timeZoneName: 'shortOffset'
    });
    var parts = fmt.formatToParts(d);
    var get = function (t) {
      for (var i = 0; i < parts.length; i++) if (parts[i].type === t) return parts[i].value;
      return null;
    };
    var tzn = get('timeZoneName') || '';
    var m = /GMT([+-]\d+)/.exec(tzn);
    var offsetHours = m ? parseInt(m[1], 10) : null;
    var offset = offsetHours != null
      ? 'UTC−' + String(Math.abs(offsetHours)).padStart(2, '0') + ':00'
      : null;
    if (offsetHours != null && offsetHours >= 0) {
      offset = 'UTC+' + String(offsetHours).padStart(2, '0') + ':00';
    }
    var hour24 = parseInt(get('hour'), 10);
    return {
      year: get('year'), month: get('month'), day: get('day'),
      hour24: hour24, minute: get('minute'), second: get('second'),
      offset: offset
    };
  }

  function _fmtClock(hour24, minute) {
    var h12 = ((hour24 + 11) % 12) + 1;
    var ampm = hour24 < 12 ? 'AM' : 'PM';
    return String(h12).padStart(2, '0') + ':' + minute + ' ' + ampm;
  }

  /**
   * toEt(ts, now=Date.now()) -> {display, offset, state, reason?}
   * Future relative to `now` => {state:'error', reason:'clock skew'} — no value rendered.
   */
  function toEt(ts, now) {
    var refNow = now != null ? _coerce(now).getTime() : Date.now();
    var d = _coerce(ts);
    if (!_isFinite(d)) {
      return { state: 'error', reason: 'invalid timestamp' };
    }
    if (d.getTime() > refNow) {
      return { state: 'error', reason: 'clock skew' };
    }
    var p = _etParts(d);
    return {
      display: _fmtClock(p.hour24, p.minute) + ' ET (' + p.offset + ')',
      offset: p.offset,
      state: 'ok'
    };
  }

  /**
   * ageFrom(ts, now=Date.now()) -> {ms, display, state, reason?}
   * Single absolute source for relative age — never compute age twice independently (C6).
   */
  function ageFrom(ts, now) {
    var refNow = now != null ? _coerce(now).getTime() : Date.now();
    var d = _coerce(ts);
    if (!_isFinite(d)) return { state: 'error', reason: 'invalid timestamp' };
    var ms = refNow - d.getTime();
    if (ms < 0) return { state: 'error', reason: 'clock skew' };
    var mins = Math.floor(ms / 60000);
    var display;
    if (mins < 1) display = 'just now';
    else if (mins < 60) display = mins + 'm ago';
    else if (mins < 1440) display = Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm ago';
    else display = Math.floor(mins / 1440) + 'd ago';
    return { ms: ms, display: display, state: 'ok' };
  }

  /**
   * sortFeedDesc(rows, canonicalField) -> rows sorted strictly descending by
   * canonicalField. A row missing the field is flagged 'ERROR — no canonical
   * timestamp <row id>' and kept at the position its (absent) timestamp would
   * imply — head of list, per VERIFY(d), never silently dropped or reordered.
   * An error-flagged row (future timestamp) stays at the position its own
   * instant sorts to; the error is a property of the row's rendered value,
   * not a reason to move it (WARROOM-RENDER-001 renders the error body).
   */
  function sortFeedDesc(rows, canonicalField, now) {
    var refNow = now != null ? _coerce(now).getTime() : Date.now();
    var withMeta = rows.map(function (row, idx) {
      var raw = row[canonicalField];
      var missing = raw === undefined || raw === null || raw === '';
      var t = missing ? null : _coerce(raw).getTime();
      var invalid = !missing && isNaN(t);
      var errored = missing || invalid;
      return {
        row: row,
        idx: idx,
        errored: errored,
        errorReason: missing
          ? ('no canonical timestamp ' + (row.id != null ? row.id : idx))
          : (invalid ? ('invalid canonical timestamp ' + (row.id != null ? row.id : idx)) : null),
        t: errored ? null : t
      };
    });
    withMeta.sort(function (a, b) {
      if (a.errored && b.errored) return a.idx - b.idx;
      if (a.errored) return -1; // errored rows sort to head, not dropped
      if (b.errored) return 1;
      return b.t - a.t; // strictly descending
    });
    return withMeta.map(function (m) {
      if (m.errored) {
        return Object.assign({}, m.row, { _clockState: 'error', _clockReason: m.errorReason });
      }
      var skew = m.t > refNow;
      return Object.assign({}, m.row, skew
        ? { _clockState: 'error', _clockReason: 'clock skew' }
        : { _clockState: 'ok' });
    });
  }

  /**
   * rollingWindow(days, now) -> {from, to} as YYYY-MM-DD (ET calendar date),
   * computed from `now` every call — no stored anchor.
   */
  function rollingWindow(days, now) {
    var refNow = now != null ? _coerce(now) : new Date();
    var toP = _etParts(refNow);
    var toStr = toP.year + '-' + toP.month + '-' + toP.day;
    var fromMs = refNow.getTime() - days * 86400000;
    var fromP = _etParts(new Date(fromMs));
    var fromStr = fromP.year + '-' + fromP.month + '-' + fromP.day;
    return { from: fromStr, to: toStr };
  }

  /**
   * inRollingWindow(ts, days, now) -> boolean, true iff ts falls within the
   * [now - days, now] window. Used by any feed that needs to filter rows to
   * a window rather than just label one (e.g. COST LEDGER "31d window").
   */
  function inRollingWindow(ts, days, now) {
    var refNow = now != null ? _coerce(now).getTime() : Date.now();
    var t = _coerce(ts).getTime();
    if (isNaN(t)) return false;
    return t <= refNow && t >= refNow - days * 86400000;
  }

  /**
   * monthBuckets(count, now) -> array of 'YYYY-MM' strings, most recent
   * (now's ET month) first, going backward — used by the 6-month forecast.
   */
  function monthBuckets(count, now) {
    var refNow = now != null ? _coerce(now) : new Date();
    var p = _etParts(refNow);
    var y = parseInt(p.year, 10);
    var m = parseInt(p.month, 10); // 1-12
    var out = [];
    for (var i = 0; i < count; i++) {
      var mm = m - i;
      var yy = y;
      while (mm <= 0) { mm += 12; yy -= 1; }
      out.push(yy + '-' + String(mm).padStart(2, '0'));
    }
    return out;
  }

  /**
   * isSameEtCalendarDay(ts, now) -> boolean, true iff ts falls on the same ET
   * calendar date as `now`. Used to fix CANVAS TODAY: "today" must mean
   * built-this-ET-calendar-day, not "newest regardless of date" (the Jun-15
   * artifact bug — fetchTodayPiece() picked newest-by-status with no date
   * filter at all).
   */
  function isSameEtCalendarDay(ts, now) {
    var refNow = now != null ? _coerce(now) : new Date();
    var d = _coerce(ts);
    if (!_isFinite(d)) return false;
    var a = _etParts(refNow);
    var b = _etParts(d);
    return a.year === b.year && a.month === b.month && a.day === b.day;
  }

  // weekdayLabel(ts) -> 'SAT AUG 23' style ET calendar label — the header
  // clock's date chip. Kept in the one time module so no render-code call
  // site hand-calls toLocaleDateString directly (gate: check-clock-gate.sh).
  function weekdayLabel(ts) {
    var d = _coerce(ts);
    if (!_isFinite(d)) return 'ERROR';
    return new Intl.DateTimeFormat('en-US', {
      timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric'
    }).format(d).toUpperCase();
  }

  // dateLabel(ts) -> 'Aug 23, 2026' (ET calendar date, no time component).
  function dateLabel(ts) {
    var d = _coerce(ts);
    if (!_isFinite(d)) return 'ERROR';
    return new Intl.DateTimeFormat('en-US', {
      timeZone: TZ, month: 'short', day: 'numeric', year: 'numeric'
    }).format(d);
  }

  // shortDateLabel(ts) -> 'Aug 23' (ET calendar date, no year) — used where
  // the surrounding context already carries the year.
  function shortDateLabel(ts) {
    var d = _coerce(ts);
    if (!_isFinite(d)) return 'ERROR';
    return new Intl.DateTimeFormat('en-US', {
      timeZone: TZ, month: 'short', day: 'numeric'
    }).format(d);
  }

  /**
   * recentTimeOrDate(ts, now) -> ET time-of-day if within 24h of `now`,
   * else an ET date label. Single shared rule for "short recency" render
   * sites (was hand-duplicated ad hoc in generate-status.js's tsShort()).
   */
  function recentTimeOrDate(ts, now) {
    var refNow = now != null ? _coerce(now).getTime() : Date.now();
    var d = _coerce(ts);
    if (!_isFinite(d)) return '';
    var diffHours = (refNow - d.getTime()) / 3600000;
    if (diffHours < 0) return 'ERROR — clock skew';
    if (diffHours < 24) {
      var p = _etParts(d);
      return _fmtClock(p.hour24, p.minute);
    }
    return shortDateLabel(d);
  }

  /**
   * etHourMinute(now) -> {hour, minute} as integers, ET calendar clock —
   * for host-timezone-independent schedule gates (e.g. "only at 9AM ET"),
   * replacing raw new Date().getHours()/getMinutes() which silently breaks
   * if the host's local timezone isn't America/New_York.
   */
  function etHourMinute(now) {
    var d = now != null ? _coerce(now) : new Date();
    var p = _etParts(d);
    return { hour: p.hour24, minute: parseInt(p.minute, 10) };
  }

  var WarroomClock = {
    TZ: TZ,
    nowUtc: nowUtc,
    toEt: toEt,
    ageFrom: ageFrom,
    sortFeedDesc: sortFeedDesc,
    rollingWindow: rollingWindow,
    inRollingWindow: inRollingWindow,
    monthBuckets: monthBuckets,
    isSameEtCalendarDay: isSameEtCalendarDay,
    weekdayLabel: weekdayLabel,
    dateLabel: dateLabel,
    shortDateLabel: shortDateLabel,
    recentTimeOrDate: recentTimeOrDate,
    etHourMinute: etHourMinute
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = WarroomClock;
  } else {
    root.WarroomClock = WarroomClock;
  }
})(typeof window !== 'undefined' ? window : this);
