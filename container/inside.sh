#!/bin/bash
# Checks a running session from inside, as root: nothing can open a connection
# out, Haute and Caddy run as haute, and Fly's in-machine files are root's alone.
#
#   docker exec -i session bash -s < container/inside.sh
set -uo pipefail
py=/project/.venv/bin/python
as_haute() { setpriv --reuid=haute --regid=haute --init-groups "$@"; }
failed=0

check() { # check <what> <command...>: the command must succeed
  local what=$1
  shift
  if "$@" > /dev/null 2>&1; then echo "ok    $what"; else echo "FAIL  $what"; failed=1; fi
}
refused() { # refused <what> <command...>: the command must fail
  local what=$1
  shift
  if "$@" > /dev/null 2>&1; then echo "FAIL  $what"; failed=1; else echo "ok    $what"; fi
}
connect() { # connect <host>: open a TCP connection to <host>:80
  "${@:2}" "$py" -c "import socket, sys; socket.create_connection((sys.argv[1], 80), timeout=5)" "$1"
}
runs_as_haute() { # runs_as_haute <command line fragment>: it runs, and only ever as haute
  local p cmd found=1
  for p in /proc/[0-9]*; do
    cmd=$(tr '\0' ' ' < "$p/cmdline" 2> /dev/null) || continue
    case "$cmd" in *"$1"*) ;; *) continue ;; esac
    [ "$(awk '/^Uid:/{print $2}' "$p/status")" = "$(id -u haute)" ] || return 1
    found=0
  done
  return $found
}

refused "haute can't connect out over IPv4" connect 1.1.1.1 as_haute
refused "haute can't connect out over IPv6" connect 2606:4700:4700::1111 as_haute
refused "root can't connect out over IPv4" connect 1.1.1.1
refused "haute can't change the firewall" as_haute iptables -P OUTPUT ACCEPT
check "Haute runs as haute" runs_as_haute "haute serve"
check "Caddy runs as haute" runs_as_haute "caddy run"
if [ -d /.fly ]; then
  refused "haute can't read Fly's in-machine files" as_haute ls /.fly
fi

exit $failed
