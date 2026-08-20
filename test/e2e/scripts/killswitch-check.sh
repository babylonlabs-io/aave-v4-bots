#!/usr/bin/env bash
#
# Verifies the running bot's kill switch, end to end, against the live process.
#
# Unit tests cover the handler and the server in isolation. This is the only place that proves the
# whole path in a real deployment: `@repo/secrets` resolved the token from RISK_CONTROL_TOKEN_REF,
# `startRiskRuntime` bound a control server on loopback, the metrics port did NOT get one, and
# halting the shared gate actually stops the engines the composition root built.
#
# Usage: killswitch-check.sh <control-port> <metrics-port> <token>
# Exits non-zero on any failed assertion, which makes `vm.ffi` revert the calling forge script.

set -euo pipefail

CONTROL_PORT="${1:?control port required}"
METRICS_PORT="${2:?metrics port required}"
TOKEN="${3:?token required}"

CONTROL="http://127.0.0.1:${CONTROL_PORT}"
METRICS="http://127.0.0.1:${METRICS_PORT}"
BODY=$(mktemp)
trap 'rm -f "$BODY"' EXIT

fail() {
  echo "KILLSWITCH CHECK FAILED: $*" >&2
  exit 1
}

# HTTP status of a request, body left in $BODY.
status() {
  curl -sS --max-time 10 -o "$BODY" -w '%{http_code}' "$@"
}

expect_status() {
  local want="$1" desc="$2"
  shift 2
  local got
  got=$(status "$@") || fail "$desc: curl failed"
  [ "$got" = "$want" ] || fail "$desc: expected HTTP $want, got $got (body: $(cat "$BODY"))"
}

expect_state() {
  local want="$1"
  expect_status 200 "GET /status" -H "Authorization: Bearer ${TOKEN}" "${CONTROL}/status"
  grep -q "\"state\":\"${want}\"" "$BODY" || fail "expected state ${want}, got: $(cat "$BODY")"
}

echo "--- Kill switch: authentication"
# No token at all.
expect_status 401 "unauthenticated POST /halt" -X POST "${CONTROL}/halt"
# A wrong token of the same length (the constant-time compare path).
expect_status 401 "wrong-token POST /halt" \
  -X POST -H "Authorization: Bearer $(printf 'x%.0s' $(seq ${#TOKEN}))" "${CONTROL}/halt"
# A non-Bearer scheme.
expect_status 401 "non-Bearer POST /halt" -X POST -H "Authorization: ${TOKEN}" "${CONTROL}/halt"
# The bot must still be trading after all of that.
expect_state RUNNING

echo "--- Kill switch: the metrics port has no control plane"
# The security property of the split: /metrics is scrapeable, and cannot stop the bot.
expect_status 404 "POST /halt on the metrics port" -X POST "${METRICS}/halt"
expect_status 404 "POST /resume on the metrics port" -X POST "${METRICS}/resume"
# …and the metrics port still serves what it is for.
expect_status 200 "GET /metrics" "${METRICS}/metrics"

echo "--- Kill switch: method enforcement"
# A GET /halt would let a link or an <img> tag stop production trading.
expect_status 405 "GET /halt" -H "Authorization: Bearer ${TOKEN}" "${CONTROL}/halt"

echo "--- Kill switch: path normalization"
# `/foo/../halt` normalizes to `/halt`; the route must refuse to serve it, so a reverse-proxy ACL
# on the literal path cannot be walked around.
expect_status 404 "traversal POST /foo/../halt" \
  -X POST --path-as-is -H "Authorization: Bearer ${TOKEN}" "${CONTROL}/foo/../halt"

echo "--- Kill switch: halt and resume"
expect_status 200 "authenticated POST /halt" \
  -X POST -H "Authorization: Bearer ${TOKEN}" "${CONTROL}/halt?reason=e2e"
grep -q '"state":"HALTED"' "$BODY" || fail "halt did not report HALTED: $(cat "$BODY")"
expect_state HALTED

expect_status 200 "authenticated POST /resume" \
  -X POST -H "Authorization: Bearer ${TOKEN}" "${CONTROL}/resume"
expect_state RUNNING

echo "--- Kill switch: bound to loopback only"
# Best-effort: `ss` is present on the CI runner. A control plane listening on 0.0.0.0 would put a
# trading-stop button on every network the pod can see.
if command -v ss >/dev/null 2>&1; then
  # Column 4 is the LOCAL address. Column 5 is the peer, and reads `0.0.0.0:*` for every listening
  # socket — matching on the whole line would flag a loopback bind as a wildcard one.
  local_addr=$(ss -ltnH "sport = :${CONTROL_PORT}" | awk 'NR==1 {print $4}')
  [ -n "$local_addr" ] || fail "nothing is listening on ${CONTROL_PORT}"
  case "$local_addr" in
    127.0.0.1:* | "[::1]:"*) echo "    control port bound to ${local_addr}" ;;
    *) fail "control server bound to ${local_addr}, expected loopback" ;;
  esac
else
  echo "    (ss unavailable — skipping bind check)"
fi

echo "killswitch ok"
