# Vendored Skills — Upstream Provenance

Sync date: 2026-05-20

All skills here are vendored copies, prefixed `vigil-` to avoid collision with
user-installed skills. Internal `name:` fields, `metadata.dependencies` entries,
and cross-references in skill bodies have been rewritten to the prefixed form.
File-internal paths (e.g. `${CLAUDE_SKILL_DIR}/references/...`) are left as the
upstream — they are resolved by the agent runtime, not by us.

## Almanac (`vendor/almanac/`)

Source: local checkout at `/Users/jakubneumann/Documents/code/neumie/almanac`
Upstream commit: `a1609a7` (`chore(skills): regroup workflow-meta skills under productivity/`)
License: MIT

| Vendored as              | Source path inside almanac repo            |
|--------------------------|--------------------------------------------|
| `vigil-task-start`       | `skills/productivity/task-start`           |
| `vigil-complexity-assess`| `skills/productivity/complexity-assess`    |
| `vigil-handoff`          | `skills/productivity/handoff`              |
| `vigil-branch-name`      | `skills/git/branch-name`                   |
| `vigil-commit`           | `skills/git/commit`                        |
| `vigil-ship`             | `skills/git/ship`                          |
| `vigil-commits-squash`   | `skills/git/commits-squash`                |
| `vigil-push`             | `skills/git/push`                          |
| `vigil-pr-create`        | `skills/git/pr-create`                     |
| `vigil-pr-watch`         | `skills/git/pr-watch`                      |
| `vigil-ci-fix`           | `skills/git/ci-fix`                        |
| `vigil-rebase`           | `skills/git/rebase`                        |

`vigil-handoff` is originally derived from Matt Pocock's MIT-licensed skills
collection (https://github.com/mattpocock/skills) and was upstreamed into
almanac in commit `f4b82a1`.

## Re-sync procedure

1. `cd /Users/jakubneumann/Documents/code/neumie/almanac && git pull` (or update fork as appropriate).
2. For each almanac skill listed above, `cp -r` the source directory over the vendored copy.
3. Re-apply the rename pass: every `name:` field, every `metadata.dependencies` entry,
   and every cross-reference in skill bodies must use the `vigil-` prefix when it points
   to another bundled skill. Mentions of non-bundled skills must be left alone.
4. Update this file's `Sync date` and the `Upstream commit`.
