# Profile data backup and restore

This runbook backs up Helm's **managed dataset only**: `helm.db`, `profiles.json`, and `profiles/`. The launchd working directory can also contain the source checkout, so never move, delete, or replace that whole directory.

The shared root `helm.db` is current truth for every profile. Retained `profiles/<id>/helm.db` files are legacy migration backups: the manifest and archive include them as files, but they are never selected as current truth.

## Preconditions and decision rule

1. Declare a maintenance window. Stop the Helm app, extension, and CLI/API writers; do not admit provider work during the procedure.
2. Record the currently deployed daemon/app build and protocol IDs. Confirm there are no active runs.
3. Use the launchd plist's `WorkingDirectory`; do not assume the shell's current directory is the data root.
4. Prefer a code rollback for a bad canary. A full snapshot restore discards every write made after the backup and requires explicit approval for that data loss.

`profile-data-manifest.mjs` accepts only a stopped, sidecar-free SQLite dataset. It rejects a live `helm.db-wal` or `helm.db-shm`, checks integrity and foreign keys in one read transaction, rejects event/Item tenant mismatches, validates the production profile registry shape and canonical IDs, and emits deterministic JSON. Its `logical` section contains profile generation, active/profile IDs, and profile-scoped Item/event/poll counts. Its `files` section contains SHA-256 values for `helm.db`, `profiles.json`, and every regular file below `profiles/`.

`profile-data-runbook-helper.mjs` is deliberately argv-only: it fails closed if `lsof` is missing, reports diagnostics, or reports an open existing database path; and it compares both `logical` and `files` manifest sections. Do not replace either check with shell interpolation or a `node -e` string.

## Create a stopped, consistent backup

Run this from any shell. It derives both the data root and helper scripts from launchd's configured working directory.

```bash
set -euo pipefail

PLIST="$HOME/Library/LaunchAgents/com.helm.daemon.plist"
ROOT=$(/usr/libexec/PlistBuddy -c 'Print :WorkingDirectory' "$PLIST")
MANIFEST="$ROOT/scripts/profile-data-manifest.mjs"
RUNBOOK_HELPER="$ROOT/scripts/profile-data-runbook-helper.mjs"
printf 'Helm data root: %s\n' "$ROOT"
test -f "$ROOT/profiles.json" && test -f "$ROOT/helm.db" && test -f "$MANIFEST" && test -f "$RUNBOOK_HELPER"

helm stop
while launchctl print "gui/$UID/com.helm.daemon" >/dev/null 2>&1; do sleep 1; done
node "$RUNBOOK_HELPER" assert-stopped-database "$ROOT"

STAMP=$(date +%Y%m%d-%H%M%S)
PARENT="$HOME/helm-backups"
mkdir -p "$PARENT"
STAGE=$(mktemp -d "$PARENT/.architecture-fix-$STAMP.XXXXXX")
# The dot command is constant; sqlite receives all paths as argv or through cd.
(
 cd "$STAGE"
 sqlite3 "$ROOT/helm.db" '.backup helm.db'
)
cp -p "$ROOT/profiles.json" "$STAGE/profiles.json"
cp -a "$ROOT/profiles" "$STAGE/profiles"
node "$MANIFEST" "$STAGE" > "$STAGE/manifest.json"
BACKUP="$PARENT/architecture-fix-$STAMP"
mv "$STAGE" "$BACKUP"
printf 'Backup: %s\n' "$BACKUP"
```

Do not accept the backup yet. First run the empty-dataset rehearsal below. The SQLite `.backup` command is deliberate: copying a live `helm.db` without its WAL is not a consistent backup.

## Rehearse into an empty dataset directory

Do not rehearse by copying onto an existing profile tree. This creates an actually empty managed dataset directory and proves the full managed-file hashes and logical profile data match.

```bash
set -euo pipefail

# BACKUP, MANIFEST, and RUNBOOK_HELPER are from the backup step.
SCRATCH=$(mktemp -d /tmp/helm-restore-rehearsal.XXXXXX)
mkdir "$SCRATCH/restored"
cp -p "$BACKUP/helm.db" "$SCRATCH/restored/helm.db"
cp -p "$BACKUP/profiles.json" "$SCRATCH/restored/profiles.json"
cp -a "$BACKUP/profiles" "$SCRATCH/restored/profiles"
node "$MANIFEST" "$SCRATCH/restored" > "$SCRATCH/restored-manifest.json"
node "$RUNBOOK_HELPER" compare-manifests "$BACKUP/manifest.json" "$SCRATCH/restored-manifest.json"
printf 'Empty-root rehearsal passed: %s\n' "$SCRATCH"
```

The backup is valid only when SHA-256 values for every managed file, SQLite integrity, foreign keys, profile generation/IDs, Item/event/poll counts, and tenant ownership match the empty-root rehearsal.

## Restore only with explicit data-loss approval

Use this only after approving the loss of all post-snapshot writes. Pin the matching daemon/app build before starting it. Stop Helm and move the failed **managed dataset** aside; do not overlay restored files onto a failed WAL or `profiles/` tree.

```bash
set -euo pipefail

# ROOT, MANIFEST, RUNBOOK_HELPER, and BACKUP must be set as above.
CHECKS=$(mktemp -d "$ROOT/.restore-check.XXXXXX")
cleanup_checks() { rm -rf "$CHECKS"; }
trap cleanup_checks EXIT

# Re-read the backup before moving the current dataset aside.
node "$MANIFEST" "$BACKUP" > "$CHECKS/backup-manifest.json"
node "$RUNBOOK_HELPER" compare-manifests "$BACKUP/manifest.json" "$CHECKS/backup-manifest.json"
helm stop
while launchctl print "gui/$UID/com.helm.daemon" >/dev/null 2>&1; do sleep 1; done
node "$RUNBOOK_HELPER" assert-stopped-database "$ROOT"

FAILED="$ROOT/failed-canary-$(date +%Y%m%d-%H%M%S)"
mkdir "$FAILED"
mv "$ROOT/helm.db" "$FAILED/"
for f in "$ROOT/helm.db-wal" "$ROOT/helm.db-shm"; do test ! -e "$f" || mv "$f" "$FAILED/"; done
mv "$ROOT/profiles.json" "$FAILED/"
mv "$ROOT/profiles" "$FAILED/"

RESTORE=$(mktemp -d "$ROOT/.restore.XXXXXX")
cp -p "$BACKUP/helm.db" "$RESTORE/helm.db"
cp -p "$BACKUP/profiles.json" "$RESTORE/profiles.json"
cp -a "$BACKUP/profiles" "$RESTORE/profiles"
# Keep validation outside RESTORE so its removal cannot block helm start.
node "$MANIFEST" "$RESTORE" > "$CHECKS/restored-manifest.json"
node "$RUNBOOK_HELPER" compare-manifests "$BACKUP/manifest.json" "$CHECKS/restored-manifest.json"

# The target dataset is empty now. These are replacements, never an overlay.
mv "$RESTORE/helm.db" "$ROOT/helm.db"
mv "$RESTORE/profiles.json" "$ROOT/profiles.json"
mv "$RESTORE/profiles" "$ROOT/profiles"
rmdir "$RESTORE"
rm -rf "$CHECKS"
trap - EXIT
helm start
```

After startup, verify `/api/status` reports the pinned expected protocol/build ID and confirm the active profile and generation before reopening clients. Do **not** rerun the manifest while the daemon is live: it intentionally rejects live SQLite sidecars. The full logical/file comparison already completed in the stopped restore staging area. Record any provider polling or new admission after the restart.

## Canary and promotion record

Before production observer changes, run one controlled observer tick against the rehearsed clone/harness. Preserve before/after manifests, affected Item IDs/status/events, GitHub command counts, and a second-tick idempotence check. Promote only when integrity and foreign keys remain clean; no tenant mismatch, SQLite-after-close, unexpected lifecycle/event delta, or restart loop appears; and per-tick command budgets remain within the release limits. Code rollback preserves legitimate observer changes; reserve full snapshot restore for corruption with explicit post-snapshot data-loss approval.
