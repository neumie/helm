# Helm app

Orchestrator cockpit for the helm daemon — and THE helm UI (the browser
dashboard `web/` is deleted; the daemon is API-only). Electron app with a
resizable split: left pane is the native React sidebar (`src/renderer/sidebar/`,
list/detail/settings), right pane is a real terminal (xterm.js + node-pty) for
claude chats and `helm ingest`.

All daemon traffic goes through the main-process `HelmBridge` (`src/helm-bridge.ts`):
one 2.5s poller pushes full `daemon:snapshot` updates over IPC when state changes, and
commands proxy single HTTP calls (the `file://` renderer never fetches `:7474` itself).
Wire types are copied into `src/shared-helm.ts` from the server contract.

The app registers the `helm://` URL scheme (`src/main.ts`): `helm://item/<id>` —
emitted by the Chrome extension's "Helm ↗" link — focuses the window and jumps
the sidebar to that item (`src/protocol.ts` parses; `nav:open-item` IPC).
The legacy `vigil://` scheme is also registered and handled identically so
pre-rename links keep working. Unpackaged dev runs may fail to claim the
scheme on macOS (logged warning).

## Install

```sh
bun install && bun run rebuild
```

`rebuild` compiles node-pty against Electron's ABI (also runs on postinstall).

## Run

```sh
bun run start
```

Daemon URL comes from `HELM_URL` (default `http://localhost:7474`; legacy
`VIGIL_URL` is still honored). If the daemon is down, the topbar dot breathes
amber and the bridge keeps polling until it is reachable.
Shortcuts: cmd+t new terminal tab, cmd+w close tab. Divider position persists.
