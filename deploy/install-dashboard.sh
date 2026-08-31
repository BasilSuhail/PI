#!/usr/bin/env bash
# Builds and installs the Jug Console as a service on this node.
# Run on jug2. Idempotent — safe to re-run to deploy an update.
set -euo pipefail

APP_DIR="/opt/jug-console"
SRC_DIR="${1:-$HOME/dashboard}"
PORT="${PORT:-8080}"
NODE_MAJOR=22

if [ ! -f "$SRC_DIR/package.json" ]; then
  echo "No package.json under $SRC_DIR — pass the source directory as the first argument." >&2
  exit 1
fi

echo "==> Node.js"
# Debian 13 ships Node 20; the build needs 22 or newer.
if ! command -v node >/dev/null || [ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -lt "$NODE_MAJOR" ]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
  sudo apt-get install -y nodejs
fi
node -v

echo "==> pnpm"
sudo npm install -g pnpm@10 --silent
pnpm -v

echo "==> Building in $SRC_DIR"
cd "$SRC_DIR"
pnpm install --frozen-lockfile --prod=false
pnpm run build

# The service and its directory were called tailnet-console before the rename.
# Carry the old install over rather than leaving a second copy running.
OLD_DIR="/opt/tailnet-console"
if [ -f /etc/systemd/system/tailnet-console.service ]; then
  echo "==> Retiring tailnet-console.service"
  sudo systemctl disable --now tailnet-console.service
  sudo rm -f /etc/systemd/system/tailnet-console.service
  sudo systemctl daemon-reload
fi
if [ -d "$OLD_DIR" ] && [ ! -d "$APP_DIR" ]; then
  echo "==> Moving $OLD_DIR to $APP_DIR"
  sudo mv "$OLD_DIR" "$APP_DIR"
fi

echo "==> Installing to $APP_DIR"
sudo mkdir -p "$APP_DIR"
sudo rsync -a --delete "$SRC_DIR/dist/" "$APP_DIR/dist/"
# apps.json ships with the rest of the build. It used to be seeded once and
# then left alone, to protect tiles edited on the node — but that also meant a
# tile added to the repo never arrived, which is how the OSINT News tile went
# missing after it was merged. The repo is the source of truth: edit
# dashboard/server/apps.json and deploy.
# node_modules is not needed: the client is bundled and the server imports
# nothing outside the standard library.

SERVICE_USER="${SERVICE_USER:-$(id -un)}"

echo "==> Checking ${SERVICE_USER} can reach tailscaled"
if ! sudo -u "$SERVICE_USER" tailscale status >/dev/null 2>&1; then
  echo "  ${SERVICE_USER} cannot query tailscaled." >&2
  echo "  Grant access with:  sudo tailscale set --operator=${SERVICE_USER}" >&2
  echo "  Node discovery will fail until then." >&2
fi

echo "==> Service on :${PORT} as ${SERVICE_USER}"
sudo tee /etc/systemd/system/jug-console.service >/dev/null <<UNIT
[Unit]
Description=Jug — fleet dashboard
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
Type=simple
Environment=PORT=${PORT}
Environment=NODE_ENV=production
WorkingDirectory=${APP_DIR}
ExecStart=$(command -v node) ${APP_DIR}/dist/server.js
Restart=always
RestartSec=5

# Discovery shells out to the tailscale CLI, which talks to the daemon over
# its local socket. Debian's tailscale package creates no group for that
# socket, so the service runs as the login user, who can already query it.
User=${SERVICE_USER}

NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
MemoryMax=256M

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable jug-console.service
sudo systemctl restart jug-console.service

echo
echo "==> Waiting for the server to bind"
for _ in $(seq 1 15); do
  ss -tln | grep -q ":${PORT}\b" && break
  sleep 1
done

echo "==> Status"
systemctl is-active jug-console.service || true
ss -tln | grep ":${PORT}\b" || echo "port ${PORT} not bound"
echo
echo "==> Probing"
curl -sf --max-time 20 "http://localhost:${PORT}/api/nodes" >/dev/null \
  && echo "/api/nodes OK" \
  || echo "/api/nodes failed — check: sudo journalctl -u jug-console -n 30"
echo
echo "Next: expose it on the tailnet with"
echo "  sudo tailscale serve --bg ${PORT}"
