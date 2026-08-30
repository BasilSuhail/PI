#!/usr/bin/env bash
# Builds and installs the tailnet console as a service on this node.
# Run on pi2. Idempotent — safe to re-run to deploy an update.
set -euo pipefail

APP_DIR="/opt/tailnet-console"
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

echo "==> Installing to $APP_DIR"
sudo mkdir -p "$APP_DIR"
sudo rsync -a --delete "$SRC_DIR/dist/" "$APP_DIR/dist/"
# node_modules is not needed: the client is bundled and the server imports
# nothing outside the standard library.

echo "==> Service on :${PORT}"
sudo tee /etc/systemd/system/tailnet-console.service >/dev/null <<UNIT
[Unit]
Description=Tailnet Console — fleet dashboard
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

# Discovery shells out to the tailscale CLI, which needs the daemon socket.
# Running as root is avoided; the tailscale group owns that socket.
User=nobody
SupplementaryGroups=tailscale

NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
MemoryMax=256M

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable tailnet-console.service
sudo systemctl restart tailnet-console.service

echo
echo "==> Waiting for the server to bind"
for _ in $(seq 1 15); do
  ss -tln | grep -q ":${PORT}\b" && break
  sleep 1
done

echo "==> Status"
systemctl is-active tailnet-console.service || true
ss -tln | grep ":${PORT}\b" || echo "port ${PORT} not bound"
echo
echo "==> Probing"
curl -sf --max-time 20 "http://localhost:${PORT}/api/nodes" >/dev/null \
  && echo "/api/nodes OK" \
  || echo "/api/nodes failed — check: sudo journalctl -u tailnet-console -n 30"
echo
echo "Next: expose it on the tailnet with"
echo "  sudo tailscale serve --bg ${PORT}"
