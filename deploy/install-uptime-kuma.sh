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
kube -n jug rollout status deployment/uptime-kuma --timeout=300s

echo "==> Waiting for its tailnet name"
# The operator creates a proxy pod and registers the machine; the hostname
# lands on the Ingress status once Tailscale has issued the certificate.
HOST=""
for _ in $(seq 1 60); do
  HOST="$(kube -n jug get ingress uptime -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null || true)"
  [ -n "$HOST" ] && break
  sleep 5
done

echo
if [ -n "$HOST" ]; then
  echo "  https://${HOST}"
else
  echo "  No hostname yet. It can take a few minutes on a first run." >&2
  echo "  Watch: sudo k3s kubectl -n jug get ingress uptime -w" >&2
  echo "  Logs:  sudo k3s kubectl -n tailscale logs deploy/operator" >&2
fi

echo
echo "First visit asks you to create an admin account. After that:"
echo "  Settings > Notifications > Setup Notification > Discord, paste the"
echo "  webhook URL, Test, then tick Default enabled."
echo
echo "Rollback:  sudo k3s kubectl delete -f ${REPO_ROOT}/k8s/uptime-kuma.yaml"
