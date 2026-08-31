# Deploys. Each target is one command that takes the board to whatever is on
# main — the board pulls, builds, and installs itself. `make` lists them.
#
# First time on a node:  make bootstrap NODE=jug2
# Every time after:      make dashboard

NODE ?= jug2
DASH_NODE ?= jug2
AGENT_NODES ?= jug jug2
# Boards with disks worth exposing. Same list today; kept separate because a
# node can run an agent without holding anything you want to browse.
STORAGE_NODES ?= jug jug2
REPO_DIR ?= PI
DASH_URL ?= https://jug2.taild9f605.ts.net

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

.PHONY: help dashboard agents deploy check logs bootstrap browse samba

help:
	@echo "make dashboard   dashboard/ or deploy/ changed, launcher tiles included"
	@echo "make agents      agent/ changed — both boards"
	@echo "make deploy      both of the above"
	@echo "make check       services up, dashboard answering"
	@echo "make logs        last 40 lines from the dashboard service"
	@echo "make browse                rebuild /srv/browse on both boards"
	@echo "make samba NODE=jug2       share that board's disks over SMB, asks for a password"
	@echo "make bootstrap NODE=jug2   once per node: deploy key + checkout"
	@echo
	@echo "Tailscale has to be up. Each target asks for the board's password once."

dashboard:
	ssh $(DASH_NODE) '$(SYNC) && bash ~/$(REPO_DIR)/deploy/install-dashboard.sh ~/$(REPO_DIR)/dashboard'

agents:
	@for node in $(AGENT_NODES); do \
		echo "==> $$node"; \
		ssh $$node '$(SYNC) && bash ~/$(REPO_DIR)/agent/install.sh' || exit 1; \
	done

deploy: dashboard agents

check:
	@ssh jug2 'systemctl is-active jug-console glances pi-metrics' || true
	@ssh jug  'systemctl is-active glances pi-metrics' || true
	@curl -s -o /dev/null -w 'dashboard: %{http_code}\n' $(DASH_URL)/api/nodes
	@echo "Want: three active on jug2, two on jug, 200 from the dashboard."

logs:
	ssh $(DASH_NODE) 'journalctl -u jug-console -n 40 --no-pager'

browse:
	@for node in $(STORAGE_NODES); do \
		echo "==> $$node"; \
		ssh $$node '$(SYNC) && bash ~/$(REPO_DIR)/deploy/setup-browse.sh' || exit 1; \
	done

# Interactive: smbpasswd prompts on the board, so this one wants a terminal
# and cannot be looped silently. One node at a time, on purpose.
samba:
	ssh -t $(NODE) '$(SYNC) && bash ~/$(REPO_DIR)/deploy/install-samba.sh'

bootstrap:
	bash deploy/bootstrap-node.sh $(NODE)
