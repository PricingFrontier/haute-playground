#!/bin/bash
# Checks a running session through its proxy: forwarded headers are stripped,
# the session's own origin gets Haute's cookie and its sync socket, and any
# other origin is still refused.
#
#   container/smoke.sh http://localhost:8080
set -uo pipefail
url=${1:-http://localhost:8080}
own=$url
foreign=https://elsewhere.example
jar=$(mktemp)
failed=0

check() { # check <expected status> <what> <curl args...>
  local want=$1 what=$2 got
  shift 2
  got=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$@")
  if [ "$got" = "$want" ]; then echo "ok    $got  $what"; else echo "FAIL  $got  $what (wanted $want)"; failed=1; fi
}
socket() { # socket <expected status> <what> <origin>: open Haute's sync WebSocket
  local want=$1 what=$2 got
  got=$(curl -s -N --max-time 3 -D - -o /dev/null -b "$jar" -H "Origin: $3" \
    -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" \
    -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" "$url/ws/sync" | head -1 | cut -d' ' -f2)
  if [ "$got" = "$want" ]; then echo "ok    $got  $what"; else echo "FAIL  $got  $what (wanted $want)"; failed=1; fi
}

check 200 "page loads" "$url/"
check 200 "forwarded headers are stripped" "$url/" \
  -H "X-Forwarded-For: 203.0.113.9" -H "X-Forwarded-Proto: https" -H "X-Forwarded-Port: 443" \
  -H "Forwarded: for=203.0.113.9"

check 200 "own origin starts a session" -X POST -H "Origin: $own" -c "$jar" "$url/api/session/bootstrap"
if grep -q haute_session "$jar"; then echo "ok         session cookie set"; else echo "FAIL       no session cookie"; failed=1; fi
check 200 "own origin with the cookie" -H "Origin: $own" -b "$jar" "$url/api/session"
socket 101 "own origin opens the sync socket" "$own"

check 403 "other origin can't start a session" -X POST -H "Origin: $foreign" "$url/api/session/bootstrap"
check 403 "other origin refused even with the cookie" -H "Origin: $foreign" -b "$jar" "$url/api/session"
socket 403 "other origin can't open the sync socket" "$foreign"

rm -f "$jar"
exit $failed
