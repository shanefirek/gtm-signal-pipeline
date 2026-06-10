#!/usr/bin/env bash
# P0 gate — mechanical verification against local wrangler dev.
# Usage: npm run dev (in one terminal), then npm run smoke.
# Exit 0 = green. Every assertion prints PASS/FAIL.

set -u
BASE="${BASE:-http://localhost:8787}"
FAILURES=0

assert() {
  local desc="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    echo "  PASS: $desc"
  else
    echo "  FAIL: $desc (expected: $expected, got: $actual)"
    FAILURES=$((FAILURES + 1))
  fi
}

echo "== 1. healthz =="
CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/healthz")
assert "GET /healthz returns 200" "200" "$CODE"

echo "== 2. valid signal ingests (202) =="
NONCE=$(date +%s%N)
BODY=$(curl -s -w "\n%{http_code}" -X POST "$BASE/signal" \
  -H "content-type: application/json" \
  -d "{\"source\":\"website_visit\",\"company\":\"Acme Corp\",\"domain\":\"acme.com\",\"page\":\"/pricing\",\"employee_count\":900,\"nonce\":\"$NONCE\"}")
CODE=$(echo "$BODY" | tail -1)
JSON=$(echo "$BODY" | head -1)
assert "POST /signal returns 202" "202" "$CODE"
SIGNAL_ID=$(echo "$JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['signal_id'])" 2>/dev/null || echo "parse_error")
TRACE_ID=$(echo "$JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['trace_id'])" 2>/dev/null || echo "parse_error")
echo "  signal_id=$SIGNAL_ID trace_id=$TRACE_ID"

echo "== 3. duplicate payload dedups (409) =="
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/signal" \
  -H "content-type: application/json" \
  -d "{\"source\":\"website_visit\",\"company\":\"Acme Corp\",\"domain\":\"acme.com\",\"page\":\"/pricing\",\"employee_count\":900,\"nonce\":\"$NONCE\"}")
assert "duplicate POST returns 409" "409" "$CODE"

echo "== 4. malformed body rejected (400) =="
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/signal" \
  -H "content-type: application/json" -d "not json")
assert "malformed POST returns 400" "400" "$CODE"

echo "== 5. bad source rejected (400) =="
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/signal" \
  -H "content-type: application/json" -d '{"source":"carrier_pigeon"}')
assert "unknown source returns 400" "400" "$CODE"

echo "== 6. signal reaches routed within 10s =="
STATUS="pending"
for _ in $(seq 1 10); do
  sleep 1
  STATUS=$(curl -s "$BASE/" | grep -o "st-routed" | head -1 || true)
  if [[ "$STATUS" == "st-routed" ]]; then break; fi
done
assert "dashboard shows a routed signal" "st-routed" "$STATUS"

echo "== 7. dashboard renders =="
CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/")
assert "GET / returns 200" "200" "$CODE"
REASON=$(curl -s "$BASE/" | grep -c "reason" || true)
[[ "$REASON" -gt 0 ]] && echo "  PASS: routed actions carry reasons" || { echo "  FAIL: no reason column found"; FAILURES=$((FAILURES+1)); }

# ---------- P1: real deterministic scoring ----------

wait_routed() {
  local trace="$1"
  for _ in $(seq 1 10); do
    sleep 1
    local st
    st=$(curl -s "$BASE/api/signal?trace_id=$trace" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['signal']['status'] if d.get('signal') else 'missing')" 2>/dev/null)
    if [[ "$st" == "routed" ]]; then return 0; fi
  done
  return 1
}

field() {
  local trace="$1" path="$2"
  curl -s "$BASE/api/signal?trace_id=$trace" | python3 -c "
import sys, json
d = json.load(sys.stdin)
obj, key = '$path'.split('.')
v = (d.get(obj) or {}).get(key)
print(v)"
}

echo "== 8. hot fixture routes hot + alert_rep =="
NONCE=$(date +%s%N)
HOT=$(curl -s -X POST "$BASE/signal" -H "content-type: application/json" \
  -d "{\"source\":\"form_fill\",\"company\":\"BigCo\",\"domain\":\"bigco.com\",\"title\":\"VP of IT\",\"employee_count\":900,\"page\":\"/pricing\",\"action\":\"demo_request\",\"nonce\":\"$NONCE\"}")
HOT_TRACE=$(echo "$HOT" | python3 -c "import sys,json; print(json.load(sys.stdin)['trace_id'])")
wait_routed "$HOT_TRACE" || { echo "  FAIL: hot fixture never routed"; FAILURES=$((FAILURES+1)); }
assert "hot fixture tier" "hot" "$(field "$HOT_TRACE" action.tier)"
assert "hot fixture action" "alert_rep" "$(field "$HOT_TRACE" action.action)"
assert "hot fixture scored deterministically" "deterministic" "$(field "$HOT_TRACE" signal.scored_by)"
FIT=$(field "$HOT_TRACE" signal.fit_score)
INTENT=$(field "$HOT_TRACE" signal.intent_score)
[[ "$FIT" -ge 70 && "$FIT" -le 100 ]] && echo "  PASS: fit $FIT in [70,100]" || { echo "  FAIL: fit $FIT out of bounds"; FAILURES=$((FAILURES+1)); }
[[ "$INTENT" -ge 70 && "$INTENT" -le 100 ]] && echo "  PASS: intent $INTENT in [70,100]" || { echo "  FAIL: intent $INTENT out of bounds"; FAILURES=$((FAILURES+1)); }

echo "== 9. junk fixture routes archive =="
NONCE=$(date +%s%N)
COLD=$(curl -s -X POST "$BASE/signal" -H "content-type: application/json" \
  -d "{\"source\":\"website_visit\",\"page\":\"/blog/some-post\",\"nonce\":\"$NONCE\"}")
COLD_TRACE=$(echo "$COLD" | python3 -c "import sys,json; print(json.load(sys.stdin)['trace_id'])")
wait_routed "$COLD_TRACE" || { echo "  FAIL: cold fixture never routed"; FAILURES=$((FAILURES+1)); }
assert "junk fixture tier" "archive" "$(field "$COLD_TRACE" action.tier)"

echo "== 10. routed action carries a non-empty reason =="
REASON=$(field "$HOT_TRACE" action.reason)
[[ -n "$REASON" && "$REASON" != "None" ]] && echo "  PASS: reason present (${REASON:0:60}...)" || { echo "  FAIL: empty reason"; FAILURES=$((FAILURES+1)); }

echo "== 11. oversized body rejected (413) =="
BIG=$(python3 -c "import json; print(json.dumps({'source':'webhook','filler':'x'*9000}))")
CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/signal" \
  -H "content-type: application/json" -d "$BIG")
assert "9KB body returns 413" "413" "$CODE"

echo "== 12. hostile payload renders escaped on dashboard (no stored XSS) =="
NONCE=$(date +%s%N)
# Hot-tier fixture: hot reasons quote the title component, so the hostile
# string is guaranteed to reach the rendered dashboard.
XSS=$(curl -s -X POST "$BASE/signal" -H "content-type: application/json" \
  -d "{\"source\":\"form_fill\",\"company\":\"EvilCo\",\"domain\":\"evil.example\",\"title\":\"VP <img src=x onerror=alert(1)>\",\"employee_count\":900,\"page\":\"/pricing\",\"action\":\"demo_request\",\"nonce\":\"$NONCE\"}")
XSS_TRACE=$(echo "$XSS" | python3 -c "import sys,json; print(json.load(sys.stdin)['trace_id'])")
wait_routed "$XSS_TRACE" || { echo "  FAIL: xss fixture never routed"; FAILURES=$((FAILURES+1)); }
DASH=$(curl -s "$BASE/")
echo "$DASH" | grep -q '<img src=x' && { echo "  FAIL: raw <img injected into dashboard"; FAILURES=$((FAILURES+1)); } || echo "  PASS: hostile markup not present raw"
echo "$DASH" | grep -q '&lt;img src=x' && echo "  PASS: hostile markup present escaped" || { echo "  FAIL: escaped form missing"; FAILURES=$((FAILURES+1)); }

echo ""
if [[ $FAILURES -eq 0 ]]; then
  echo "SMOKE GREEN ($(date))"
  exit 0
else
  echo "SMOKE RED: $FAILURES failure(s)"
  exit 1
fi
