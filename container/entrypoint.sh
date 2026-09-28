#!/bin/bash
# Runs Haute and the proxy in front of it; the session ends when either stops.
set -euo pipefail
: "${PUBLIC_ORIGIN:?set PUBLIC_ORIGIN to the address the visitor opens, e.g. https://s7.play.pricing-frontier.co.uk}"

trap 'kill $(jobs -p) 2>/dev/null' TERM INT
caddy run --config /etc/caddy/Caddyfile --adapter caddyfile &
/project/.venv/bin/haute serve --host 127.0.0.1 --port 8000 --no-browser &
wait -n
