#!/usr/bin/env python3
"""Writes an Uptime Kuma import file of new monitors cloned from a live one.

Each new monitor copies everything from the template (URL, interval, retries,
Discord notification) and changes only its name and keyword, so the file is
built from Kuma's own database instead of guessed. Read-only on the database.

  sudo python3 deploy/kuma-import-json.py 24 "New name=keyword" ... > kuma.json

Import it in Kuma under Settings > Backup > Import with "Skip existing".
Kuma imports monitors paused: press Resume on each one after.
Never "Overwrite": that deletes every monitor and its history.
"""
import json
import os
import sqlite3
import sys
import urllib.parse

DB = os.environ.get("KUMA_DB", "/1) Archive/Apps/Uptime/data/kuma.db")

if len(sys.argv) < 3:
    sys.exit(__doc__)
template_id = int(sys.argv[1])

con = sqlite3.connect(f"file:{urllib.parse.quote(DB)}?mode=ro", uri=True)
con.row_factory = sqlite3.Row
row = con.execute("select * from monitor where id = ?", (template_id,)).fetchone()
if row is None:
    sys.exit(f"No monitor {template_id}")
m = dict(row)
notifications = {
    str(r[0]): True
    for r in con.execute("select notification_id from monitor_notification where monitor_id = ?", (template_id,))
}
version = (con.execute("select value from setting where key = 'version'").fetchone() or ["1.23.16"])[0]
version = json.loads(version) if str(version).startswith('"') else version

# Kuma's export names (monitor.toJSON), which is what its import reads.
base = {
    # The template's description is about its own drive, not the clone's.
    "description": None,
    "type": m.get("type"),
    "url": m.get("url"),
    "method": m.get("method") or "GET",
    "body": m.get("body"),
    "headers": m.get("headers"),
    "authMethod": m.get("auth_method"),
    "basic_auth_user": m.get("basic_auth_user"),
    "basic_auth_pass": m.get("basic_auth_pass"),
    "timeout": m.get("timeout"),
    "interval": m.get("interval"),
    "retryInterval": m.get("retry_interval"),
    "resendInterval": m.get("resend_interval") or 0,
    "hostname": m.get("hostname"),
    "maxretries": m.get("maxretries"),
    "port": m.get("port"),
    "invertKeyword": bool(m.get("invert_keyword")),
    "ignoreTls": bool(m.get("ignore_tls")),
    "upsideDown": bool(m.get("upside_down")),
    "maxredirects": m.get("maxredirects"),
    "accepted_statuscodes": json.loads(m.get("accepted_statuscodes_json") or '["200-299"]'),
    "dns_resolve_type": m.get("dns_resolve_type"),
    "dns_resolve_server": m.get("dns_resolve_server"),
    "expiryNotification": bool(m.get("expiry_notification")),
    "packetSize": m.get("packet_size"),
    "httpBodyEncoding": m.get("http_body_encoding"),
    "proxyId": m.get("proxy_id"),
    "notificationIDList": notifications,
    "active": True,
    "tags": [],
}

monitors = []
for arg in sys.argv[2:]:
    name, _, keyword = arg.partition("=")
    monitors.append({**base, "name": name.strip(), "keyword": keyword.strip()})

json.dump({"version": version, "notificationList": [], "monitorList": monitors}, sys.stdout, indent=2)
print()
