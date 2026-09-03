# Deploys. Each target is one command that takes the board to whatever is on
# main — the board pulls, builds, and installs itself. `make` lists them.
#
# First time on a node:  make bootstrap NODE=pi2
# Every time after:      make dashboard

NODE ?= pi2
DASH_NODE ?= pi2
AGENT_NODES ?= pi pi2
# Boards with disks worth exposing. Same list today; kept separate because a
# node can run an agent without holding anything you want to browse.
STORAGE_NODES ?= pi pi2
REPO_DIR ?= PI
DASH_URL ?= https://pi2.<tailnet>.ts.net

# Take the node's checkout to exactly origin/main. Deterministic on purpose:
# what is on the board afterwards is what is on main, anything edited on the
# board included. Edit the repo, not the node.
# Fails with a usable sentence rather than a git fatal when the board has no
# checkout yet — that is the one-time bootstrap, and it is easy to skip.
SYNC = { [ -d ~/$(REPO_DIR)/.git ] || { echo "no checkout on this board — run: make bootstrap NODE=<node>" >&2; exit 2; }; } \
 && git -C ~/$(REPO_DIR) fetch --quiet origin \
 && git -C ~/$(REPO_DIR) checkout --quiet main \
 && git -C ~/$(REPO_DIR) reset --hard --quiet origin/main \
 && git -C ~/$(REPO_DIR) log --oneline -1

# One board failing used to abandon the rest of the loop, so a problem on the
# first node silently became a problem on every node. Each board gets its turn
# and the failures are reported together at the end.
define on_storage_nodes
	failed=""; \
	for node in $(STORAGE_NODES); do \
		echo "==> $$node"; \
		ssh $$node '$(SYNC) && bash ~/$(REPO_DIR)/$(1)' || failed="$$failed $$node"; \
	done; \
	if [ -n "$$failed" ]; then echo; echo "Failed on:$$failed" >&2; exit 1; fi
endef

.PHONY: help dashboard dashboard-k8s uptime vault agents deploy check logs bootstrap archive automount browse samba mounts sata

help:
	@echo "make dashboard-k8s   dashboard/ or deploy/ changed — this is what runs"
	@echo "make dashboard       the old systemd unit, kept as the way back. Not both."
	@echo "make uptime          Uptime Kuma on its own tailnet name, asks for an OAuth client once"
	@echo "make vault           Vaultwarden on its own tailnet name, needs make uptime first"
	@echo "make agents          agent/ changed — both boards"
	@echo "make deploy          dashboard-k8s and agents together"
	@echo "make check           services up, dashboard answering"
	@echo "make logs            last 40 lines from the dashboard, systemd or k3s"
	@echo "make archive               create /srv/archive on both boards, once"
	@echo "make automount             plugged-in drives mount themselves, once"
	@echo "make browse                rebuild /srv/browse on both boards"
	@echo "make samba NODE=pi2       share that board's disks over SMB, asks for a password"
	@echo "make mounts                Mac only, once: shares mount while Tailscale is up"
	@echo "make sata NODE=pi2        report the PCIe port and the SATA HAT. Changes nothing."
	@echo "make bootstrap NODE=pi2   once per node: deploy key + checkout"
	@echo
	@echo "Tailscale has to be up. Each target asks for the board's password once."

dashboard:
	ssh $(DASH_NODE) '$(SYNC) && bash ~/$(REPO_DIR)/deploy/install-dashboard.sh ~/$(REPO_DIR)/dashboard'

# -t because the first run asks for a Tailscale API key: a pod has no
# tailscaled socket, so node discovery has to use the API.
dashboard-k8s:
	ssh -t $(DASH_NODE) '$(SYNC) && bash ~/$(REPO_DIR)/deploy/install-dashboard-k8s.sh ~/$(REPO_DIR)/dashboard'

# -t because the first run asks for a Tailscale OAuth client, which the
# operator needs before it can put a Service on the tailnet under its own name.
uptime:
	ssh -t $(DASH_NODE) '$(SYNC) && bash ~/$(REPO_DIR)/deploy/install-uptime-kuma.sh'

# Needs the Tailscale operator, which `make uptime` installs. No prompts of its
# own: registration opens for the first account and is closed by hand after.
vault:
	ssh $(DASH_NODE) '$(SYNC) && bash ~/$(REPO_DIR)/deploy/install-vaultwarden.sh'

agents:
	@for node in $(AGENT_NODES); do \
		echo "==> $$node"; \
		ssh $$node '$(SYNC) && bash ~/$(REPO_DIR)/agent/install.sh' || exit 1; \
	done

# The k3s dashboard, not the systemd one. `deploy` used to chain `dashboard`,
# which installs the systemd unit — so the everyday convenience target quietly
# installed the way back and left the board holding both, which is the one
# thing the README says not to do. It now runs whatever is actually live.
deploy: dashboard-k8s agents

# The dashboard is asked about separately from the agents. It runs either as a
# systemd unit or as a Deployment depending on which target was last used, and
# neither target records which — so the board is asked rather than assumed.
check:
	@ssh pi2 'systemctl is-active glances pi-metrics' || true
	@ssh pi  'systemctl is-active glances pi-metrics' || true
	@ssh $(DASH_NODE) 'bash ~/$(REPO_DIR)/deploy/dashboard-status.sh status' \
	  || echo "dashboard: could not ask $(DASH_NODE) — is its checkout current?"
	@curl -s -o /dev/null -w 'dashboard url: %{http_code}\n' $(DASH_URL)/api/nodes
	@echo "Want: two active on each board, the dashboard installed one way not two, 200 from the URL."

logs:
	@ssh $(DASH_NODE) 'bash ~/$(REPO_DIR)/deploy/dashboard-status.sh logs'

archive:
	@$(call on_storage_nodes,deploy/setup-archive.sh)

automount:
	@$(call on_storage_nodes,deploy/setup-automount.sh)

browse:
	@$(call on_storage_nodes,deploy/setup-browse.sh)

# Interactive: smbpasswd prompts on the board, so this one wants a terminal
# and cannot be looped silently. One node at a time, on purpose.
samba:
	ssh -t $(NODE) '$(SYNC) && bash ~/$(REPO_DIR)/deploy/install-samba.sh'

# Runs on the Mac and touches only the Mac: mount points, a keychain entry per
# board, and an agent that keeps the mounts in step with the tailnet.
mounts:
	STORAGE_NODES="$(STORAGE_NODES)" bash deploy/install-share-mounts.sh

bootstrap:
	bash deploy/bootstrap-node.sh $(NODE)

# Read-only. It prints the config.txt line to add rather than adding it, since
# a wrong line there stops the board booting and there is no monitor on it.
sata:
	ssh $(NODE) '$(SYNC) && bash ~/$(REPO_DIR)/deploy/check-sata-hat.sh'
