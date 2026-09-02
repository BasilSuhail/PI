#!/usr/bin/env bash
# Runs the dashboard in k3s instead of under systemd. Issue #89.
#
# Run this on the Mac, not on the board — unlike every other script in here.
# The image has to be built where Docker is, and jug2 runs containerd without
# Docker, so it cannot build its own.
#
# SSH to the boards is password-only by choice (see docs/build-log.md), so this
# asks for the password a few times. That is expected, not a fault.
set -euo pipefail

NODE="${NODE:-jug2}"
IMAGE=jug-console
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export KUBECONFIG="${KUBECONFIG:-$HOME/.kube/config-jug2}"

if [ -z "${TAILSCALE_API_KEY:-}" ]; then
  echo "TAILSCALE_API_KEY is not set." >&2
  echo "  A pod has no tailscaled socket, so node discovery has to use the API." >&2
  echo "  Make a key at https://login.tailscale.com/admin/settings/keys and re-run:" >&2
  echo "    TAILSCALE_API_KEY=tskey-api-... make dashboard-k8s" >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "Docker is not running — start Docker Desktop and re-run." >&2
  exit 1
fi

# The tag is the commit, so applying the manifest is what triggers a rollout.
# A reused tag with imagePullPolicy: IfNotPresent would leave the old image in
# place and report success.
TAG="$(git -C "$REPO_ROOT" rev-parse --short HEAD)"
git -C "$REPO_ROOT" diff --quiet HEAD || TAG="${TAG}-dirty$(date +%H%M%S)"
echo "==> Image ${IMAGE}:${TAG}"

# The boards are arm64 and the Mac may not be, so the platform is explicit.
docker buildx build --platform linux/arm64 --load \
  -t "${IMAGE}:${TAG}" "${REPO_ROOT}/dashboard"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "==> Copying the image to ${NODE}"
docker save "${IMAGE}:${TAG}" -o "${TMP}/image.tar"
scp "${TMP}/image.tar" "${NODE}:/tmp/jug-console.tar"
# k3s ctr talks to k3s' own containerd in the k8s.io namespace, which is the
# one the kubelet looks in. Plain `ctr` would import somewhere invisible to it.
ssh -t "${NODE}" "sudo k3s ctr images import /tmp/jug-console.tar && rm -f /tmp/jug-console.tar"

echo "==> Cluster access for the node labels"
kubectl apply -f "${REPO_ROOT}/k8s/dashboard-node-reader.yaml"

echo "==> Manifests"
# The namespace and the secret go first: the Deployment mounts the secret, and
# a pod whose secret does not exist yet sits in CreateContainerConfigError
# until it does.
kubectl create namespace jug --dry-run=client -o yaml | kubectl apply -f - >/dev/null
# create --dry-run | apply is the idiom for a secret that has to be updatable;
# plain create fails on the second run. The key is never echoed.
kubectl -n jug create secret generic jug-console-tailscale \
  --from-literal=api-key="${TAILSCALE_API_KEY}" \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null
sed "s/__TAG__/${TAG}/" "${REPO_ROOT}/k8s/dashboard.yaml" | kubectl apply -f -

echo "==> Waiting for the rollout"
kubectl -n jug rollout status deployment/jug-console --timeout=180s

echo "==> Retiring the systemd unit"
# Both would answer, on different ports, and the tailnet URL would follow
# whichever `tailscale serve` points at. Leaving it running is how a stale
# build ends up looking like the live one.
ssh -t "${NODE}" '
  sudo systemctl disable --now jug-console.service 2>/dev/null || true
  sudo tailscale serve reset
  sudo tailscale serve --bg 80
  sudo tailscale serve status
'

echo
echo "==> Probing through the ingress"
kubectl -n jug get pods -o wide
echo
echo "Check the tailnet URL in a browser. Rollback:"
echo "  kubectl -n jug rollout undo deployment/jug-console"
echo "Back to systemd entirely:"
echo "  kubectl delete -f k8s/dashboard.yaml && make dashboard"
