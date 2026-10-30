#!/usr/bin/env bash
# Launch a side-by-side Helm dev instance from THIS checkout next to the
# operator's running Helm (HELM_SIDE_BY_SIDE=1, see app/src/side-by-side.ts).
#
# It gets its own profile dir + dtach socket namespace, reads the live daemon
# (task sidebar) without ever writing to it, polls Okena for the agent dock,
# and skips protocol handlers, the scheduled-run lease/attention, and the
# document-review control host.
#
# Usage: app/scripts/side-by-side.sh [--build|--no-build] [extra electron args]
# Env:   HELM_DOCK_DEV_USER_DATA  profile dir (default ~/Library/Application Support/Helm-dock-dev)
#        HELM_DOCK_DEV_SOCKET_DIR dtach socket root (default /tmp/helm-dockdev-<uid>)
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="$(cd "$APP_DIR/.." && pwd)"
USER_DATA="${HELM_DOCK_DEV_USER_DATA:-$HOME/Library/Application Support/Helm-dock-dev}"
SOCKET_ROOT="${HELM_DOCK_DEV_SOCKET_DIR:-/tmp/helm-dockdev-$(id -u)}"

build=auto
if [[ "${1:-}" == "--build" ]]; then
	build=yes
	shift
elif [[ "${1:-}" == "--no-build" ]]; then
	build=no
	shift
fi

needs_build() {
	local stamp="$APP_DIR/dist/main.cjs"
	[[ -f "$stamp" && -f "$REPO_DIR/dist/cli/helm.js" ]] || return 0
	# Any source newer than the last app bundle → rebuild. Generated files are
	# skipped: Storybook/tests rewrite them after a build without a source change.
	[[ -n "$(find "$APP_DIR/src" "$REPO_DIR/src" -type f -newer "$stamp" ! -name '*.generated.*' -print -quit 2>/dev/null)" ]]
}

if [[ "$build" == yes ]] || { [[ "$build" == auto ]] && needs_build; }; then
	echo "[side-by-side] building app (bun run build)…" >&2
	(cd "$APP_DIR" && bun run build)
fi

SPOOL_DIR="$USER_DATA/agent-dock"
cat >&2 <<EOF
[side-by-side] Helm (dock dev)
  profile (userData): $USER_DATA
  dtach socket root:  $SOCKET_ROOT
  agent-dock spool:   $SPOOL_DIR
  watch it with:      node "$REPO_DIR/dist/cli/helm.js" dock watch --dir "$SPOOL_DIR"
EOF

# macOS routes helm:// / vigil:// by BUNDLE ID, and the operator's Helm (an
# unpackaged `electron .`) runs as com.github.Electron, the same id as this
# checkout's Electron.app. Run the dev instance from an APFS clone of it with
# its own bundle id so LaunchServices can never hand it the operator's links.
# The clone lives in node_modules (reinstall drops it) and is rebuilt whenever
# Electron's version changes. This checkout's own Electron.app is not modified.
ELECTRON_BIN="./node_modules/.bin/electron"
if [[ "$(uname -s)" == Darwin ]]; then
	DEV_BUNDLE_ID="com.github.Electron.helm-dockdev"
	SRC_APP="$APP_DIR/node_modules/electron/dist/Electron.app"
	DEV_DIR="$APP_DIR/node_modules/.helm-dockdev"
	DEV_APP="$DEV_DIR/Helm Dock Dev.app"
	src_version="$(cat "$APP_DIR/node_modules/electron/dist/version" 2>/dev/null || echo unknown)"
	if [[ ! -x "$DEV_APP/Contents/MacOS/Electron" || "$(cat "$DEV_DIR/version" 2>/dev/null)" != "$src_version" ]]; then
		echo "[side-by-side] cloning Electron.app as ${DEV_BUNDLE_ID}…" >&2
		rm -rf "$DEV_DIR"
		mkdir -p "$DEV_DIR"
		cp -c -R "$SRC_APP" "$DEV_APP" 2>/dev/null || cp -R "$SRC_APP" "$DEV_APP"
		plist="$DEV_APP/Contents/Info.plist"
		/usr/bin/plutil -replace CFBundleIdentifier -string "$DEV_BUNDLE_ID" "$plist"
		/usr/bin/plutil -replace CFBundleName -string "Helm Dock Dev" "$plist"
		/usr/bin/plutil -replace CFBundleDisplayName -string "Helm Dock Dev" "$plist"
		for helper in "$DEV_APP"/Contents/Frameworks/*.app; do
			/usr/bin/plutil -replace CFBundleIdentifier -string "$DEV_BUNDLE_ID.helper" "$helper/Contents/Info.plist"
		done
		printf '%s' "$src_version" >"$DEV_DIR/version"
	fi
	actual_id="$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$DEV_APP/Contents/Info.plist")"
	if [[ "$actual_id" != "$DEV_BUNDLE_ID" ]]; then
		echo "[side-by-side] refusing: dev Electron bundle id is '$actual_id', not $DEV_BUNDLE_ID" >&2
		exit 1
	fi
	ELECTRON_BIN="$DEV_APP/Contents/MacOS/Electron"
fi

cd "$APP_DIR"
# Terminals of the dev instance get HELM_AGENT_DOCK_DIR=<userData>/agent-dock from main.ts,
# so `helm dock` there reads the dev spool.
HELM_SIDE_BY_SIDE=1 HELM_SOCKET_DIR="$SOCKET_ROOT" exec "$ELECTRON_BIN" . --user-data-dir="$USER_DATA" "$@"
