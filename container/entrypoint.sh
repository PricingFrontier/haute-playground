#!/bin/bash
# Runs as root only long enough to wall the session in, then hands over to
# session.sh as the haute user, which can never get root back.
set -euo pipefail
: "${PUBLIC_ORIGIN:?set PUBLIC_ORIGIN to the address the visitor opens, e.g. https://s7.play.pricing-frontier.co.uk}"

# Visitors can run any Python, so nothing in the session may open a connection
# out. Loopback and replies to inbound connections are allowed, and so is IPv6
# neighbour discovery: without it the machine stops answering on Fly's IPv6
# network, where every inbound connection arrives.
for ipt in iptables ip6tables; do
  $ipt -A OUTPUT -o lo -j ACCEPT
  $ipt -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
done
for type in 133 134 135 136; do
  ip6tables -A OUTPUT -p icmpv6 --icmpv6-type "$type" -j ACCEPT
done
iptables -P OUTPUT DROP
ip6tables -P OUTPUT DROP

# Fly's in-machine API and its files are root's alone
if [ -d /.fly ]; then chmod 700 /.fly; fi

exec env HOME=/home/haute USER=haute LOGNAME=haute \
  setpriv --reuid=haute --regid=haute --init-groups --no-new-privs \
    --inh-caps=-all --bounding-set=-all \
  /usr/local/bin/playground-session
