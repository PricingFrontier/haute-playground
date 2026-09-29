#!/bin/bash
# Replace the pool's idle session machines so the pool refills on the current image.
# Pool machines keep the image they were created with, so run this after a new
# session image is pushed. Sessions in use (a machine with a claim) are never touched;
# they end as usual and their machines are destroyed then.
#
#   launcher/refresh-pool.sh            # destroy the idle pool machines
#   launcher/refresh-pool.sh --dry-run  # only list what it would destroy
#
# Needs flyctl (logged in) and jq.
set -euo pipefail
export MSYS_NO_PATHCONV=1

APP=pricing-frontier-playground
FLY=${FLY:-$(command -v flyctl || command -v fly || echo "$HOME/.fly/bin/flyctl")}
dry_run=false
[ "${1:-}" = "--dry-run" ] && dry_run=true

idle() {
  "$FLY" machine list -a "$APP" --json |
    jq -r '.[] | select(.config.metadata.role == "playground-session")
                | select((.config.metadata.claim // "") == "")
                | "\(.id) \(.state) \(.image_ref.digest // "")"'
}

machines=$(idle)
if [ -z "$machines" ]; then
  echo "No idle pool machines."
  exit 0
fi
echo "Idle pool machines:"
echo "$machines" | sed 's/^/  /'
$dry_run && exit 0

echo "$machines" | while read -r id _state _digest; do
  # Check again just before destroying: a visitor may have claimed it since the list.
  claim=$("$FLY" machine status "$id" -a "$APP" --display-config 2>/dev/null |
    grep -o '"claim": *"[^"]*"' || true)
  if [ -n "$claim" ]; then
    echo "  $id was claimed meanwhile; left alone"
    continue
  fi
  "$FLY" machine destroy "$id" -a "$APP" --force >/dev/null && echo "  destroyed $id"
done
echo "The launcher refills the pool on the new image within a minute or so."
