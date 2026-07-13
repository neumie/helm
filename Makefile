.PHONY: install uninstall restart status logs build test check

build: node_modules
	npm run build

test: node_modules
	npm run test

check: build

install: build
	npm link
	helm start
	@echo "\n✓ Helm installed and running. API: http://localhost:7474/api (clients: app + extension)"
	@echo "  Use: helm start | stop | status | logs"

uninstall:
	helm stop
	npm unlink -g helm
	@echo "\n✓ Helm stopped and unlinked."

restart: build
	-helm stop 2>/dev/null
	helm start
	@echo "\n✓ Helm restarted."

status:
	@helm status

logs:
	@helm logs

node_modules: package.json
	npm install
	@touch node_modules
