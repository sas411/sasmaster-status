#!/usr/bin/env bash
# SC2-P0-EGRESS-001 — adversarial probe for the /api/status public/internal split.
#
#   ./scripts/probe-status-egress.sh [base-url] [repo-root]
#   default base-url:  https://sasmaster-status.vercel.app
#   default repo-root: the directory two levels up from this script
#
# ACCEPTANCE (§30): run this from a network with NO relationship to this estate, by an
# agent that did not build the change. Set STATUS_API_KEY in the environment to also
# exercise the operator path (leave it unset to skip that block — the probe will say so
# rather than silently passing).
#
# Exits non-zero on any failure.

set -uo pipefail

BASE="${1:-https://sasmaster-status.vercel.app}"
ROOT="${2:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
PASS=0; FAIL=0
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

ok()   { printf '  PASS  %-56s %s\n' "$1" "${2:-}"; PASS=$((PASS+1)); }
bad()  { printf '  FAIL  %-56s %s\n' "$1" "${2:-}"; FAIL=$((FAIL+1)); }
hr()   { printf '%s\n' "----------------------------------------------------------------------"; }

echo "probe-status-egress.sh  base=$BASE"
hr
echo "THE PUBLIC DOCUMENT"

code=$(curl -sS -o "$TMP/pub.json" -w '%{http_code}' --max-time 30 "$BASE/api/status")
bytes=$(wc -c < "$TMP/pub.json" | tr -d ' ')
[ "$code" = "200" ] && ok "anonymous GET /api/status returns 200" "$code" \
                    || bad "anonymous GET /api/status returns 200" "got=$code"

# §39 — the size is RECORDED as a measured baseline, never thresholded.
printf '  INFO  %-56s public_bytes=%s\n' "measured public payload size" "$bytes"

# Exact key-set equality against the committed allow-list. Not "fewer keys",
# not "no obvious secrets".
# FINDING SC2-P0-EGRESS-001-F1: the card's ACCEPTANCE block specifies
#   jq '[paths(scalars)] | .[] | map(tostring) | join(".")'
# That expression is NULL-BLIND. Measured with jq 1.7:
#   echo '{"a":null,"b":1}' | jq -r '[paths(scalars)]|.[]|join(".")'   ->  b
# A null-valued key VANISHES from the derived set, so the diff would FAIL the moment
# any field is null — and null is exactly what §39 requires when a value is absent or
# unrecognised. The expression below is leaf-path based and null-safe. Both are run;
# a disagreement between them means a public field is null and is worth investigating.
if command -v jq >/dev/null 2>&1; then
  JQ_LEAVES='[paths as $p | select((getpath($p)|type) != "object" and (getpath($p)|type) != "array") | $p] | .[] | map(tostring) | join(".")'
  jq -r "$JQ_LEAVES" "$TMP/pub.json" | sed -E 's/\.[0-9]+\./.[]./g' | sort -u > "$TMP/public-keys.txt"
  if diff -q "$TMP/public-keys.txt" "$ROOT/docs/status-public-allowlist.txt" >/dev/null 2>&1; then
    ok "public key set == docs/status-public-allowlist.txt" "exact"
  else
    bad "public key set == docs/status-public-allowlist.txt" "see diff below"
    diff "$TMP/public-keys.txt" "$ROOT/docs/status-public-allowlist.txt" || true
  fi
  jq -r '[paths(scalars)] | .[] | map(tostring) | join(".")' "$TMP/pub.json" \
    | sed -E 's/\.[0-9]+\./.[]./g' | sort -u > "$TMP/public-keys-cardexpr.txt"
  if ! diff -q "$TMP/public-keys.txt" "$TMP/public-keys-cardexpr.txt" >/dev/null 2>&1; then
    printf '  INFO  %-56s %s\n' "a public field is null" \
      "$(comm -23 "$TMP/public-keys.txt" "$TMP/public-keys-cardexpr.txt" | tr '\n' ' ')"
  fi
else
  bad "public key set == allow-list" "jq not installed — CANNOT VERIFY (not a pass)"
fi

# Credential battery against the LIVE public response.
hits=$(grep -cEo '(AKIA|ASIA)[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|arn:aws:[a-z0-9-]+:|X-Amz-Signature=|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.' "$TMP/pub.json" 2>/dev/null || true)
[ "${hits:-0}" = "0" ] && ok "zero credential-shaped values in the public body" \
                       || bad "zero credential-shaped values in the public body" "hits=$hits"

# Operational topology must not survive.
leaked=""
for n in 'TASK-' 'highItems' 's3://' 'sasmaster-2026' '/Users/' 'cost_usd' '"command"' '"log"' 'jarvis'; do
  grep -qF -- "$n" "$TMP/pub.json" 2>/dev/null && leaked="$leaked $n"
done
[ -z "$leaked" ] && ok "no O-bucket topology in the public body" \
                 || bad "no O-bucket topology in the public body" "leaked:$leaked"

hr
echo "THE INTERNAL DOCUMENT IS GATED"

read -r c b < <(curl -sS -o /dev/null -w '%{http_code} %{size_download}' --max-time 30 \
  "$BASE/api/status?scope=internal")
[ "$c" = "401" ] && [ "$b" = "0" ] && ok "no key -> 401 with an EMPTY body" "$c $b" \
                                   || bad "no key -> 401 with an EMPTY body" "got=$c $b"

read -r c b < <(curl -sS -o /dev/null -w '%{http_code} %{size_download}' --max-time 30 \
  -H 'x-api-key: wrong-key' "$BASE/api/status?scope=internal") # gitleaks:allow — intentional negative-test value, not a credential
[ "$c" = "401" ] && [ "$b" = "0" ] && ok "wrong key -> 401 with an EMPTY body" "$c $b" \
                                   || bad "wrong key -> 401 with an EMPTY body" "got=$c $b"

if [ -n "${STATUS_API_KEY:-}" ]; then
  code=$(curl -sS -o "$TMP/int.json" -w '%{http_code}' --max-time 30 \
    -H "x-api-key: $STATUS_API_KEY" "$BASE/api/status?scope=internal")
  ib=$(wc -c < "$TMP/int.json" | tr -d ' ')
  if [ "$code" = "200" ] && [ "$ib" -gt 10000 ]; then
    ok "correct key -> the full document (operator kept the tool)" "$code ${ib}B"
  else
    bad "correct key -> the full document" "got=$code ${ib}B"
  fi
  if curl -sSI --max-time 30 -H "x-api-key: $STATUS_API_KEY" \
       "$BASE/api/status?scope=internal" | grep -qi '^cache-control:.*no-store'; then
    ok "internal response is Cache-Control: no-store"
  else
    bad "internal response is Cache-Control: no-store"
  fi
  if curl -sSI --max-time 30 -H "x-api-key: $STATUS_API_KEY" \
       "$BASE/api/status?scope=internal" | grep -qi '^access-control-allow-origin'; then
    bad "internal response sends NO ACAO" "header present"
  else
    ok "internal response sends NO ACAO"
  fi
else
  printf '  SKIP  %-56s %s\n' "operator path" "STATUS_API_KEY unset — NOT VERIFIED"
fi

hr
echo "THE SECOND DOOR — the same payload on the static path"
echo "  api/status.js is only one of two ways this payload reaches the public."
echo "  vercel.json serves the repo root via {\"handle\":\"filesystem\"}, and status.json"
echo "  is committed there. Neither file is owned by SC2-P0-EGRESS-001 (§23)."
read -r c b < <(curl -sS -o /dev/null -w '%{http_code} %{size_download}' --max-time 30 "$BASE/status.json")
if [ "$c" = "200" ] && [ "${b:-0}" -gt 10000 ]; then
  bad "GET /status.json is not public" "STILL OPEN: $c ${b}B — hand to the vercel.json owner"
else
  ok "GET /status.json is not public" "$c ${b}B"
fi

hr
printf 'RESULT: %d passed, %d failed\n' "$PASS" "$FAIL"
echo
echo "STILL REQUIRED, and NOT checkable from here:"
echo "  vercel logs <deployment-url> | grep -i 'status-guard' | tail -5"
echo "    -> entries present, each naming method + path + reason, and NO key-shaped value"
echo "  vercel ls --prod | head -3   -> newest MUST read '● Ready' (§31 r1);"
echo "                                  an Error deploy leaves the leak OPEN."
echo "  A human loads the War Room in a browser and sees POPULATED panels (§32/§39):"
echo "    an empty panel reads as a missing generator and costs the next investigator hours."
[ "$FAIL" -eq 0 ] || exit 1
