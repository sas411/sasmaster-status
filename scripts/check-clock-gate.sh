#!/usr/bin/env bash
# WARROOM-CLOCK-001 — value-render gate runner.
#
# Bans ambient date formatting in render code: any new Date/toLocaleString/
# toLocaleTimeString/toLocaleDateString call in warroom-v5.html or
# generate-status.js MUST go through lib/warroom-clock.js (WarroomClock.*),
# never hand-rolled. WARROOM-RENDER-001 extends this same runner with the
# em-dash rule — do not fork a second gate script.
#
# Usage: scripts/check-clock-gate.sh [files...]
#   No args -> checks the two known render surfaces.
# Exit 0 = clean. Exit 1 = banned pattern found, printed with file:line.

set -euo pipefail
cd "$(dirname "$0")/.."

FILES=("$@")
if [ ${#FILES[@]} -eq 0 ]; then
  # WARROOM-RENDER-001 remediation (2026-08-24, MAINTAINER gap 7): lib/warroom-render.js was
  # never in the default scan set, so its own em-dash-fallback pattern (formatAge()) went
  # unchecked by the gate that this same card introduced. Added.
  FILES=(warroom-v5.html generate-status.js lib/warroom-render.js)
fi

fail=0

for f in "${FILES[@]}"; do
  [ -f "$f" ] || continue

  # Ban ad-hoc toLocaleTimeString()/toLocaleDateString() calls OUTSIDE
  # lib/warroom-clock.js. Deliberately NOT banning plain .toLocaleString() —
  # that method exists on both Date and Number, and this codebase uses it
  # extensively for legitimate thousands-separator NUMBER formatting
  # (e.g. `count.toLocaleString()`); a grep-based gate cannot disambiguate
  # receiver type, and banning it wholesale produces constant false positives
  # unrelated to this card's clock-skew defect. toLocaleTimeString/
  # toLocaleDateString are unambiguous — Date-only — so those stay banned.
  hits=$(grep -nE '\.toLocale(TimeString|DateString)\(' "$f" | grep -v 'warroom-clock\.js' || true)
  if [ -n "$hits" ]; then
    echo "[clock-gate] $f: ambient toLocaleTimeString/toLocaleDateString() call — must go through WarroomClock.toEt()/ageFrom():"
    echo "$hits" | sed "s|^|  $f:|"
    fail=1
  fi

  # Ban raw getHours()/getMinutes()/getSeconds() render (the header-clock
  # pattern this card fixed) outside the clock module.
  hits=$(grep -nE '\.get(Hours|Minutes|Seconds)\(\)' "$f" | grep -v 'warroom-clock\.js' || true)
  if [ -n "$hits" ]; then
    echo "[clock-gate] $f: raw Date getHours/getMinutes/getSeconds in render code — must go through WarroomClock:"
    echo "$hits" | sed "s|^|  $f:|"
    fail=1
  fi
done

for f in "${FILES[@]}"; do
  [ -f "$f" ] || continue

  # WARROOM-RENDER-001 — C2 em-dash payload rule, extended into this SAME
  # runner (not a second gate script, per C6). The card's own text says this
  # rule "operates on the tile payload, not on page prose" — a static grep
  # cannot see runtime payload objects, so lib/warroom-render.js's
  # assertValidPayload() is the real, authoritative enforcement at runtime.
  # This is a best-effort static heuristic on top of that: it flags the exact
  # ternary-fallback pattern that produced every em-dash bug this card fixed
  # (`cond?value:'—'` / `'--'` / `'---'`), which is cheap to catch before
  # runtime and catches regressions of the same shape. It will not catch every
  # possible em-dash-as-value site and is not a substitute for the runtime
  # assertion — documented here, not silently oversold.
  hits=$(grep -nE "\?[^:]*:\s*['\"](\xe2\x80\x94|--|---)['\"]" "$f" || true)
  if [ -n "$hits" ]; then
    echo "[clock-gate] $f: ternary fallback to a bare em-dash/double-dash literal — use WarroomRender.makeNA()/makeError(), never a bare dash (C2):"
    echo "$hits" | sed "s|^|  $f:|"
    fail=1
  fi
done

for f in "${FILES[@]}"; do
  [ -f "$f" ] || continue

  # WARROOM-CLOCK-DEDUP-002 (2026-08-27) — raw millisecond-arithmetic age calc, the class of
  # bug that survived WARROOM-CLOCK-001's timeSince() removal by changing shape: instead of a
  # named duplicate function, hand-rolled `Date.now()-X)/86400000` (or /3600000, /60000) age
  # math with no clock-skew guard. Same-line heuristic (a raw Date subtraction AND a
  # ms-per-unit division on the SAME line) — deliberately does not flag a duration computed on
  # one line and divided on another (the legitimate future-countdown pattern at this card's own
  # documented exemption site uses exactly that separation). Fix: WarroomClock.ageFrom(ts,now).ms.
  hits=$(grep -nE '(Date\.now\(\)|new Date\()[^;]*\/(86400000|3600000|60000)\b' "$f" | grep -v 'warroom-clock\.js' || true)
  if [ -n "$hits" ]; then
    echo "[clock-gate] $f: raw Date.now()/new Date(...) subtraction divided inline by a ms-per-unit constant — no clock-skew guard, use WarroomClock.ageFrom(ts,now).ms:"
    echo "$hits" | sed "s|^|  $f:|"
    fail=1
  fi
done

if [ "$fail" -ne 0 ]; then
  echo "[clock-gate] FAIL — ambient date formatting or bare-dash payload fallback found."
  exit 1
fi

echo "[clock-gate] PASS — no ambient date formatting outside lib/warroom-clock.js, no bare-dash ternary fallbacks found."
exit 0
