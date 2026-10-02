# Helm Document Review — existing-session Pi connector

Opt-in private local Pi package; requires Pi 0.99.1 and an updated running Helm desktop. It does not install/configure/start the desktop or spawn an agent. The factory registers the `helm_review` tool, `/helm-review` command, and agent instructions, with no connection IO.

Operator installation:

```sh
pi install /absolute/path/to/helm/packages/helm-document-review
```

Then `/reload` in the existing ordinary Pi terminal and `/helm-review path/to/spec.md`. The agent may call `helm_review` directly with `action: 'open'` and `file`. Selection feedback becomes a follow-up through that runtime’s public API, keeping its original context, tools and permissions. Only replies after observing the exact review prompt are projected. `/helm-review disconnect` closes the surface, never Pi.

CLI `helm review` supports every provider through foreground wait/return/reply tools; it is not idle injection. No user settings are edited by Helm. Paths/tokens stay private; no provider/session file access, terminal input, auto-enrollment, process ownership or automatic replay is involved. Before-navigation fences cannot be cleared by cancelled navigation or idle heuristics. Already-dispatched Pi follow-ups cannot be retracted by this connector.

See [usage, security boundaries and evidence categories](../../docs/document-review.md). Typecheck with `HELM_DOCUMENT_REVIEW_PI=/path/to/installed/CLI.js node scripts/check-document-review-pi.mjs` from Helm’s root; it checks the real installed API without altering its dependencies/settings. Current verification targets Pi 0.99.1; later API changes need explicit verification, not a shim.
