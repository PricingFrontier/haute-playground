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

# Haute caps each worker's real memory with a child cgroup when it can create one
# under its own cgroup v2. Otherwise it caps address space instead, which CatBoost
# can't train under: Polars' threads reserve most of it before the model library
# loads (2 GB machine: 1.9 GB of a 2 GB cap reserved, 220 MB really in use). Fly
# machines mount cgroups in the v1 layout, so on Fly move the memory controller
# to v2 (the kernel frees it a moment after the v1 unmount), mount v2 where Haute
# looks, and let haute create cgroups under its root.
if [ -n "${FLY_MACHINE_ID:-}" ]; then
  umount /sys/fs/cgroup/memory
  for _ in $(seq 100); do
    grep -qw memory /sys/fs/cgroup/unified/cgroup.controllers && break
    sleep 0.1
  done
  echo +memory > /sys/fs/cgroup/unified/cgroup.subtree_control
  mount -t cgroup2 cgroup2 /sys/fs/cgroup
  chown haute /sys/fs/cgroup /sys/fs/cgroup/cgroup.procs
  chmod u+w /sys/fs/cgroup
fi

exec env HOME=/home/haute USER=haute LOGNAME=haute \
  setpriv --reuid=haute --regid=haute --init-groups --no-new-privs \
    --inh-caps=-all --bounding-set=-all \
  /usr/local/bin/playground-session
