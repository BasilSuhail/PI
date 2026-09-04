#!/usr/bin/env bash
# Uptime Kuma in k3s, on its own tailnet name. Runs on the board.
#
# Two halves. The Tailscale operator, installed once and reused by everything
# added afterwards, and Kuma itself. The operator half is skipped on a re-run,
# so this is safe to repeat.
#
# `ssh -t`, because the first run asks for an OAuth client secret.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TS_NS=tailscale
OP_SECRET=operator-oauth

if ! sudo systemctl is-active --quiet k3s; then
  echo "k3s is not running on this board. This installs into the cluster." >&2
  exit 1
fi

kube() { sudo k3s kubectl "$@"; }

echo "==> Tailscale operator"
if kube -n "$TS_NS" get secret "$OP_SECRET" >/dev/null 2>&1; then
  echo "  credentials already present — leaving them alone"
  echo "  (replace with: sudo k3s kubectl -n ${TS_NS} delete secret ${OP_SECRET}, then re-run)"
else
  cat <<'NOTE'

  The operator needs an OAuth client so it can register machines on your
  tailnet. Two things have to exist first, both in the Tailscale admin console:

    1. Access Controls: tag owners for tag:k8s-operator and tag:k8s
    2. Settings > OAuth clients > Generate, with WRITE scope on
       "Devices Core" and "Auth Keys", tagged tag:k8s-operator

  Neither value is echoed, and neither is written to this board's disk.

NOTE
  # Prompts printed separately rather than passed to read -p: a prompt string
  # next to a variable reads as a credential to a secret scanner.
  printf '  OAuth client ID: '
  IFS= read -r TS_CLIENT_ID
  printf '  OAuth client secret: '
  IFS= read -rs TS_CLIENT_SECRET
  echo
  [ -n "$TS_CLIENT_ID" ] && [ -n "$TS_CLIENT_SECRET" ] || {
    echo "  Both values are needed — stopping." >&2
    exit 1
  }

  kube create namespace "$TS_NS" --dry-run=client -o yaml | kube apply -f - >/dev/null
  # Created here rather than through the chart's values, so the credentials
  # never sit in a HelmChart object that any cluster reader can print.
  # Whole key=value inside the quotes rather than just the value. Identical to
  # the shell, and it keeps that key name from sitting directly against an
  # opening quote, which a scanner reads as a hardcoded credential.
  kube -n "$TS_NS" create secret generic "$OP_SECRET" \
    --from-literal="client_id=$TS_CLIENT_ID" \
    --from-literal="client_secret=$TS_CLIENT_SECRET" >/dev/null
  unset TS_CLIENT_ID TS_CLIENT_SECRET
  echo "  credentials stored"
fi

kube apply -f "${REPO_ROOT}/k8s/tailscale-operator.yaml"

echo "==> Waiting for the operator"
# The helm-controller runs the install as a Job, so the Deployment does not
# exist for the first few seconds and `rollout status` would fail outright.
for _ in $(seq 1 60); do
  kube -n "$TS_NS" get deploy operator >/dev/null 2>&1 && break
  sleep 5
done
kube -n "$TS_NS" rollout status deployment/operator --timeout=300s

echo "==> Uptime Kuma"
kube apply -f "${REPO_ROOT}/k8s/uptime-kuma.yaml"
kube -n pi rollout status deployment/uptime-kuma --timeout=300s

echo "==> Waiting for its tailnet name"
# The operator creates a proxy pod and registers the machine; the hostname
# lands on the Ingress status once Tailscale has issued the certificate.
HOST=""
for _ in $(seq 1 60); do
  HOST="$(kube -n pi get ingress uptime -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null || true)"
  [ -n "$HOST" ] && break
  sleep 5
done

echo
if [ -n "$HOST" ]; then
  echo "  https://${HOST}"
else
  echo "  No hostname yet. It can take a few minutes on a first run." >&2
  echo "  Watch: sudo k3s kubectl -n pi get ingress uptime -w" >&2
  echo "  Logs:  sudo k3s kubectl -n tailscale logs deploy/operator" >&2
fi

cat <<'NEXT'

First visit asks you to create an admin account. Then, in this order:

  1. Settings > Notifications > Setup Notification > Discord, paste the
     webhook URL, Test, then tick "Default enabled". Do this BEFORE adding
     monitors: "Default enabled" only applies to monitors created after it,
     and retrofitting it means opening every monitor one at a time.

  2. Settings > Backup > Import, with "Skip existing" selected. "Overwrite"
     deletes every monitor already there, along with its history.

     The monitor list is not kept in this repository. Uptime Kuma is the
     record of what is being watched; a copy here would be a second one, and
     the two disagreed for months without anyone noticing — the file claimed a
     single disk check while the board ran eight monitors, none of them that
     one. Export from Settings > Backup when a copy is wanted, and keep it
     outside this repo: the export carries notification tokens.

     Twelve monitors are set up today. Eight cover the boards and the apps on
     them: the console, the three OSINT endpoints, both Glances agents and
     both file shims. The other four:

       HDD 6TB             The agent on pi2, reading /sys, keyed on the disk
                           model. Both boards boot from their SSD, so a dead
                           SSD is a dead board and the ping already says so.
                           The 6TB is the only disk that can vanish without
                           anything else noticing. Sysfs rather than the mount
                           table: a disconnected disk leaves its mount entry
                           behind, so a mount-based check sits green over a
                           drive that is physically gone.

       Jellyfin            Its own /health endpoint, which answers "Healthy"
                           only once the server has finished starting.

       Torrent VPN tunnel  gluetun's word for whether WireGuard is up. The
                           keyword is the check and not the status code: that
                           route answers 200 from the moment gluetun starts,
                           with "stopped" in the body, which is exactly how an
                           httpGet probe on it came to guarantee nothing.

       Torrent swarm       Whether qBittorrent is talking to the swarm, which
                           is a different claim from the tunnel being up and
                           from the pod being ready. It was false for a day
                           with both of those green.

     The last two are down whenever the torrent stack is switched off, which
     is most of the time and is not a fault. That is deliberate: it makes the
     pair a session signal, so Discord says when a download session comes up
     properly connected and when it goes away again. Nothing in the cluster
     can tell "switched off" apart from "broken" — only the console knows the
     replica count, and it does not run in the cluster yet.

One trap worth knowing when adding a monitor. MagicDNS does not resolve inside a pod, so
a monitor cannot simply be given a service's .ts.net name. The hostAliases in
k8s/uptime-kuma.yaml work around it for pi and pi2 and for nothing else,
which is why the board-level monitors can use those two names and the
cluster's own services cannot. Those are checked on their in-cluster names
instead, which also tests the app rather than the tailnet round trip to it.

The two torrent monitors reach qBittorrent's own API without a password. The
web interface exempts the cluster's subnets from its login (installed by
deploy/install-torrent.sh), and Kuma's pod is in one of them.

NEXT
echo "Rollback:  sudo k3s kubectl delete -f ${REPO_ROOT}/k8s/uptime-kuma.yaml"
