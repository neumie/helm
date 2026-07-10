# helm

Orchestrator cockpit for the vigil daemon. Electron app with a resizable split:
left pane embeds the vigil dashboard (served by the daemon at `http://localhost:7474`),
right pane is a real terminal (xterm.js + node-pty) for claude chats and `vigil ingest`.

## Install

```sh
npm install && npm run rebuild
```

`rebuild` compiles node-pty against Electron's ABI (also runs on postinstall).

## Run

```sh
npm start
```

Daemon URL comes from `VIGIL_URL` (default `http://localhost:7474`). If the daemon is
down, the left pane shows a retry note and polls until it is reachable.
Shortcuts: cmd+t new terminal tab, cmd+w close tab. Divider position persists.
