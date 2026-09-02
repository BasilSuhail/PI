#!/usr/bin/env bash
# Runs the dashboard in k3s instead of under systemd. Issue #89.
#
# Runs on the board, like every other script in here. pi2 builds its own image
# with buildkit, which uses k3s' containerd as its worker — so the image is
# written straight into the namespace the kubelet reads. No registry, no tar,
# no second container runtime, and no other machine involved.
set -euo pipefail

SRC_DIR="${1:-$HOME/dashboard}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# The kubelet resolves a bare `pi-console:tag` to this, so the image is built
# under the name it will be pulled by.
IMAGE=docker.io/library/pi-console
BUILDKIT_VERSION=v0.33.0
BUILDKIT_ADDR=unix:///run/buildkit/buildkitd.sock
CONTAINERD_SOCK=/run/k3s/containerd/containerd.sock

if [ ! -f "$SRC_DIR/Dockerfile" ]; then
  echo "No Dockerfile under $SRC_DIR — pass the source directory as the first argument." >&2
  exit 1
fi

if ! sudo systemctl is-active --quiet k3s; then
  echo "k3s is not running on this board. This script installs into the cluster;" >&2
  echo "use deploy/install-dashboard.sh for the systemd service instead." >&2
  exit 1
fi

if [ ! -S "$CONTAINERD_SOCK" ]; then
  echo "No containerd socket at ${CONTAINERD_SOCK} — is this a k3s server?" >&2
  exit 1
fi

kube() { sudo k3s kubectl "$@"; }

echo "==> buildkit ${BUILDKIT_VERSION}"
# Only the daemon and the client are wanted; the rest of the tarball is the
# rootless helpers, which have nothing to do here.
if [ "$(buildctl --version 2>/dev/null | awk '{print $3}')" != "$BUILDKIT_VERSION" ]; then
  ARCH="$(dpkg --print-architecture)"
  TARBALL="buildkit-${BUILDKIT_VERSION}.linux-${ARCH}.tar.gz"
  # The tarball is 97MB and carries CNI plugins, qemu shims and a runc it does
  # not need here; only the daemon and the client are kept, 102MB installed.
  #
  # No --strip-components: the archive's only top-level entry is bin/, so the
  # two land at /usr/local/bin, which is where the unit below looks for them
  # and the only place on PATH. Stripping the component drops them in
  # /usr/local, where nothing finds them.
  TMP="$(mktemp -d)"
  curl -fsSL -o "${TMP}/bk.tgz" \
    "https://github.com/moby/buildkit/releases/download/${BUILDKIT_VERSION}/${TARBALL}"
  sudo tar -xzf "${TMP}/bk.tgz" -C /usr/local bin/buildkitd bin/buildctl
  rm -rf "$TMP"
fi
buildctl --version

echo "==> buildkitd"
# --oci-worker=false: without it buildkit brings its own snapshotter and builds
# into a store nothing else can see. The containerd worker writes into k3s'
# own containerd, in the k8s.io namespace the kubelet reads, which is the
# entire point of doing this on the board.
sudo tee /etc/systemd/system/buildkit.service >/dev/null <<UNIT
[Unit]
Description=BuildKit — builds the dashboard image into k3s' containerd
After=k3s.service
Requires=k3s.service

[Service]
Type=simple
ExecStart=/usr/local/bin/buildkitd \\
  --addr ${BUILDKIT_ADDR} \\
  --oci-worker=false \\
  --containerd-worker=true \\
  --containerd-worker-addr ${CONTAINERD_SOCK} \\
  --containerd-worker-namespace k8s.io
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
# Deliberately not enabled at boot. buildkitd is wanted for the length of a
# build and holds tens of MB the rest of the time; on these boards RAM is the
# scarce thing. Started here, stopped on the way out however this exits.
sudo systemctl restart buildkit.service
trap 'sudo systemctl stop buildkit.service 2>/dev/null || true' EXIT

for _ in $(seq 1 20); do
  sudo buildctl --addr "$BUILDKIT_ADDR" debug workers >/dev/null 2>&1 && break
  sleep 1
done
sudo buildctl --addr "$BUILDKIT_ADDR" debug workers

# The tag is the commit, so applying the manifest is what triggers a rollout.
# A reused tag under imagePullPolicy: IfNotPresent would leave the old image in
# place and report success.
TAG="$(git -C "$REPO_ROOT" rev-parse --short HEAD)"
git -C "$REPO_ROOT" diff --quiet HEAD || TAG="${TAG}-dirty$(date +%H%M%S)"

echo "==> Building ${IMAGE}:${TAG}"
sudo buildctl --addr "$BUILDKIT_ADDR" build \
  --frontend dockerfile.v0 \
  --local context="$SRC_DIR" \
  --local dockerfile="$SRC_DIR" \
  --output "type=image,name=${IMAGE}:${TAG}"

echo "==> Cluster access for the node labels"
kube apply -f "${REPO_ROOT}/k8s/dashboard-node-reader.yaml"

echo "==> Manifests"
# The namespace and the secret go first: the Deployment mounts the secret, and
# a pod whose secret does not exist yet sits in CreateContainerConfigError
# until it does.
kube create namespace pi --dry-run=client -o yaml | kube apply -f - >/dev/null

if ! kube -n pi get secret pi-console-tailscale >/dev/null 2>&1; then
  echo
  echo "  A pod has no tailscaled socket, so node discovery uses the Tailscale API."
  echo "  Make a key at https://login.tailscale.com/admin/settings/keys"
  echo "  It is not echoed, and it goes into a Secret rather than onto this board."
  # Prompt printed separately rather than passed to read -p: the secret scanner
  # reads a prompt string next to a variable as a credential in the source.
  printf '  Tailscale API key: '
  IFS= read -rs TS_KEY
  echo
  [ -n "$TS_KEY" ] || { echo "  No key given — stopping." >&2; exit 1; }
  kube -n pi create secret generic pi-console-tailscale --from-literal=api-key="$TS_KEY" >/dev/null
  unset TS_KEY
  echo "  secret created"
else
  echo "  tailscale secret already present — leaving it alone"
  echo "  (replace it with: sudo k3s kubectl -n pi delete secret pi-console-tailscale, then re-run)"
fi

sed "s/__TAG__/${TAG}/" "${REPO_ROOT}/k8s/dashboard.yaml" | kube apply -f -

echo "==> Waiting for the rollout"
kube -n pi rollout status deployment/pi-console --timeout=180s

echo "==> Retiring the systemd unit"
# Both would answer on different ports, and the tailnet URL would follow
# whichever `tailscale serve` points at. Leaving it running is how a stale
# build ends up looking like the live one.
sudo systemctl disable --now pi-console.service 2>/dev/null || true
sudo tailscale serve reset
sudo tailscale serve --bg 80
sudo tailscale serve status

echo
echo "==> Probing through the ingress"
curl -sf --max-time 20 -o /dev/null -w "  localhost:80 -> HTTP %{http_code}\n" http://localhost/ \
  || echo "  ingress did not answer — sudo k3s kubectl -n pi logs deploy/pi-console"
kube -n pi get pods -o wide

echo
echo "Rollback:            sudo k3s kubectl -n pi rollout undo deployment/pi-console"
echo "Back to systemd:     sudo k3s kubectl delete -f ${REPO_ROOT}/k8s/dashboard.yaml && make dashboard"
