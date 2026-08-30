#!/usr/bin/env bash
# Installs the node agents: Glances (general metrics) + pi-metrics (power, throttle).
# Idempotent. Safe to re-run.
set -euo pipefail

GLANCES_PORT=61208
SHIM_PORT=9101

echo "==> Installing Glances"
sudo apt-get update -qq
sudo apt-get install -y glances

echo "==> Glances as a service on :${GLANCES_PORT}"
# --disable-webui serves the REST API without Glances' own frontend.
sudo tee /etc/systemd/system/glances.service >/dev/null <<UNIT
[Unit]
Description=Glances REST API for the fleet dashboard
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/glances -w --disable-webui --port ${GLANCES_PORT} -t 2
Restart=always
RestartSec=5
MemoryMax=192M

[Install]
WantedBy=multi-user.target
UNIT

echo "==> Installing pi-metrics shim on :${SHIM_PORT}"
sudo install -m 755 "$(dirname "$0")/pi-metrics.py" /usr/local/bin/pi-metrics.py
sudo install -m 644 "$(dirname "$0")/pi-metrics.service" /etc/systemd/system/pi-metrics.service

sudo systemctl daemon-reload
sudo systemctl enable --now glances.service pi-metrics.service

echo
echo "==> Status"
systemctl is-active glances.service pi-metrics.service || true
echo
echo "==> Probing"
curl -sf "http://localhost:${SHIM_PORT}/metrics" | head -c 400 || echo "shim not answering yet"
echo
curl -sf "http://localhost:${GLANCES_PORT}/api/4/now" || echo "glances not answering yet"
echo
