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

echo ""
if [[ $FAILURES -eq 0 ]]; then
  echo "SMOKE GREEN ($(date))"
  exit 0
else
  echo "SMOKE RED: $FAILURES failure(s)"
  exit 1
fi
