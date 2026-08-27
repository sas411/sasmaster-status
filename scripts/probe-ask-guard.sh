#!/usr/bin/env bash
# SC2-P0-SSRF-001 — adversarial conformance probe for the /api/ask admission contract.
#
#   ./scripts/probe-ask-guard.sh [base-url]
#   default base-url: https://sasmaster-status.vercel.app
#
# This is the ACCEPTANCE suite (§30) and it must be run by an agent OTHER than the
# builder, from a network with no relationship to this estate. It tests the CONTRACT,
# not the implementation, so it is also the conformance suite for any future
# replacement of the guard (Vercel middleware, edge config, WAF rule).
#
# The SSRF target is example.com — IANA-reserved. NEVER point it at a host you do not
# control and NEVER at a request-catcher service: a successful probe would deliver
# ASK_API_KEY to whoever runs it. If any check below shows a 2xx on an SSRF case,
# treat ASK_API_KEY as COMPROMISED and rotate under §51 before anything else.
#
# Exits non-zero on any failure.

set -uo pipefail

BASE="${1:-https://sasmaster-status.vercel.app}"
GOOD_ORIGIN="https://sasmaster-status.vercel.app"
PASS=0; FAIL=0

hr() { printf '%s\n' "------------------------------------------------------------------"; }

# check <label> <expected-code> <curl args...>
check() {
  local label="$1" want="$2"; shift 2
  local got; got=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 45 "$@" 2>/dev/null)
  if [ "$got" = "$want" ]; then
    printf '  PASS  %-52s %s\n' "$label" "$got"; PASS=$((PASS+1))
  else
    printf '  FAIL  %-52s got=%s want=%s\n' "$label" "$got" "$want"; FAIL=$((FAIL+1))
  fi
}

# header_absent <label> <header-regex> <curl args...>
header_absent() {
  local label="$1" pat="$2"; shift 2
  if curl -sSI --max-time 45 "$@" 2>/dev/null | grep -qiE "$pat"; then
    printf '  FAIL  %-52s header PRESENT (must be absent)\n' "$label"; FAIL=$((FAIL+1))
  else
    printf '  PASS  %-52s header absent\n' "$label"; PASS=$((PASS+1))
  fi
}

header_present() {
  local label="$1" pat="$2"; shift 2
  if curl -sSI --max-time 45 "$@" 2>/dev/null | grep -qiE "$pat"; then
    printf '  PASS  %-52s header present\n' "$label"; PASS=$((PASS+1))
  else
    printf '  FAIL  %-52s header MISSING\n' "$label"; FAIL=$((FAIL+1))
  fi
}

echo "probe-ask-guard.sh  base=$BASE"
hr
echo "GATE 1 — Origin admission"

check "cross-origin evil.example is refused" 403 \
  -H "Origin: https://evil.example" "$BASE/api/ask?path=/health"

header_absent "  ...and the Origin is NOT reflected" '^access-control-allow-origin' \
  -H "Origin: https://evil.example" "$BASE/api/ask?path=/health"

header_present "  ...and Vary: Origin is set" '^vary:.*origin' \
  -H "Origin: https://evil.example" "$BASE/api/ask?path=/health"

check "suffix-match trap is refused" 403 \
  -H "Origin: https://sasmaster-status.vercel.app.evil.com" "$BASE/api/ask?path=/health"

check "MISSING Origin does not reach upstream" 403 \
  "$BASE/api/ask?path=/health"

check "denied preflight fails" 403 \
  -X OPTIONS -H "Origin: https://evil.example" \
  -H "Access-Control-Request-Method: POST" "$BASE/api/ask"

header_absent "  ...denied preflight sends no ACAO" '^access-control-allow-origin' \
  -X OPTIONS -H "Origin: https://evil.example" \
  -H "Access-Control-Request-Method: POST" "$BASE/api/ask"

hr
echo "GATES 2-4 — path admission (valid Origin, so a 400 proves the PATH gate)"

check "absolute URL in ?path is refused" 400 \
  -H "Origin: $GOOD_ORIGIN" "$BASE/api/ask?path=https://example.com/"
check "protocol-relative //host is refused" 400 \
  -H "Origin: $GOOD_ORIGIN" "$BASE/api/ask?path=//example.com/"
check "backslash variant is refused" 400 \
  -H "Origin: $GOOD_ORIGIN" "$BASE/api/ask?path=/%5Cexample.com/"
check "array-valued path is refused" 400 \
  -H "Origin: $GOOD_ORIGIN" "$BASE/api/ask?path=/ask&path=https://example.com/"
check "bare / is refused" 400 \
  -H "Origin: $GOOD_ORIGIN" "$BASE/api/ask?path=/"
check "off-policy on-origin path is refused" 400 \
  -H "Origin: $GOOD_ORIGIN" -X POST "$BASE/api/ask?path=/api/v1/s3/presign"

hr
echo "GATE 5 — method admission (kills <img>/<script>/<iframe> quota burn)"

check "GET on /ask is refused" 405 \
  -H "Origin: $GOOD_ORIGIN" "$BASE/api/ask?path=/ask"

hr
echo "THE LEGITIMATE PATH STILL WORKS"
echo "  (before SC2-P0-ASKKEY-001 lands, HTTP 401 from Railway is EXPECTED and is a"
echo "   PASS for this card — it proves admission succeeded and reached upstream.)"
LEGIT=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 45 -X POST "$BASE/api/ask" \
  -H 'content-type: application/json' -H "Origin: $GOOD_ORIGIN" \
  -d '{"question":"How many movies are in the catalog?"}' 2>/dev/null)
if [ "$LEGIT" = "403" ] || [ "$LEGIT" = "400" ] || [ "$LEGIT" = "405" ]; then
  printf '  FAIL  %-52s got=%s (guard broke the front-end)\n' "legitimate browser POST admitted" "$LEGIT"; FAIL=$((FAIL+1))
else
  printf '  PASS  %-52s got=%s\n' "legitimate browser POST admitted" "$LEGIT"; PASS=$((PASS+1))
fi

check "allowed preflight succeeds" 204 \
  -X OPTIONS -H "Origin: $GOOD_ORIGIN" \
  -H "Access-Control-Request-Method: POST" "$BASE/api/ask"

hr
printf 'RESULT: %d passed, %d failed\n' "$PASS" "$FAIL"
echo
echo "STILL REQUIRED, and NOT checkable from here (§41 / §30):"
echo "  vercel logs <deployment-url> | grep -F 'ask-guard' | tail -20"
echo "    -> entries present, each naming a reason"
echo "  and re-run the credential regex over those lines -> 0 matches:"
echo "    grep -cEo '(AKIA|ASIA)[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{20,}'"
echo "  and confirm no attacker-supplied URL is echoed verbatim into any log line."
echo "  vercel ls --prod | head -3   -> newest MUST read '● Ready' (§31 r1);"
echo "                                  an Error deploy leaves the proxy OPEN."
[ "$FAIL" -eq 0 ] || exit 1
