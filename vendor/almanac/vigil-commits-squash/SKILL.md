---
name: vigil-commits-squash
description: "Use when squashing commits on the current branch into fewer logical commits. Triggers: squash, clean up commits, combine commits, tidy history before push or PR."
---

# Commits Squash

Squash commits on the current branch into fewer, logically grouped commits. Each resulting commit must be independently revertable — reverting any single commit leaves the codebase in a working state.

## The Revertability Rule

Every resulting commit must satisfy: `git revert <sha>` produces a working codebase. This means:

- A commit that adds a function AND its call site must include both — never split them
- A commit that changes an interface must update all callers in the same commit
- A commit that adds a dependency must include the code using it
- Test changes go with the code they test

Group by **code dependency**, not just by topic or file proximity. Read the actual diffs to trace what depends on what.

## Critical: anchor on the merge-base, never on `origin/<base>`

If `origin/<base>` has moved forward since the branch was created, the branch is **diverged**. In that case:

- `git diff origin/<base>..HEAD` shows main's new files as **deletions** in your branch — they were never on the branch, but they exist on main.
- `git reset --soft origin/<base>` followed by a commit would commit those deletions, **wiping out work that was merged into main while the branch existed.**

Always compute the **merge-base** of the branch and `origin/<base>` first, and use that SHA as the anchor for the diff, log range, and soft-reset. The merge-base is the point where the branch actually started; squashing onto it preserves exactly the work your branch contributed and touches nothing else.

If you want the squashed branch to also be up-to-date with `origin/<base>`, that is a **rebase**, not a squash — run the `vigil-rebase` skill after squashing.

## Phase 1 — Analyze

These commands run automatically when the skill loads — output replaces each line below:

- PR base (if any): !`gh pr view --json baseRefName -q '.baseRefName' 2>/dev/null || true`
- origin/main exists: !`git rev-parse --verify origin/main 2>/dev/null && echo origin/main || true`
- origin/master exists: !`git rev-parse --verify origin/master 2>/dev/null && echo origin/master || true`
- Working tree status: !`git status`
- Branch commits: !`git log "origin/$(gh pr view --json baseRefName -q '.baseRefName' 2>/dev/null || (git rev-parse --verify origin/main >/dev/null 2>&1 && echo main || echo master))..HEAD" --oneline 2>/dev/null || true`
- Divergence (ahead/behind base): !`git fetch origin "$(gh pr view --json baseRefName -q '.baseRefName' 2>/dev/null || (git rev-parse --verify origin/main >/dev/null 2>&1 && echo main || echo master))" --quiet 2>/dev/null; git rev-list --left-right --count "origin/$(gh pr view --json baseRefName -q '.baseRefName' 2>/dev/null || (git rev-parse --verify origin/main >/dev/null 2>&1 && echo main || echo master))...HEAD" 2>/dev/null || true`
- Merge-base SHA: !`git merge-base "origin/$(gh pr view --json baseRefName -q '.baseRefName' 2>/dev/null || (git rev-parse --verify origin/main >/dev/null 2>&1 && echo main || echo master))" HEAD 2>/dev/null || true`

### Step 1: Determine base and anchor

Pick `<base>` from the pre-run output:

1. PR base if `gh pr view` returned one
2. Otherwise `main` if it exists
3. Otherwise `master`

Then **set `<anchor>` to the Merge-base SHA** from the pre-run output. Every command in the rest of the skill — diff, log range, reset — uses `<anchor>`, not `origin/<base>`. If the divergence line shows `0` on the left (base hasn't moved), `<anchor>` equals `origin/<base>` and behavior is unchanged; if it shows a non-zero left count, using `<anchor>` is what prevents data loss.

If Merge-base SHA is empty (no shared history), **STOP** and report — the branch is not based on `<base>` and squashing is unsafe.

### Step 2: Check prerequisites

- From `git status` output: if uncommitted changes exist, follow the `vigil-commit` skill first, then continue.
- Check for in-progress rebase: `.git/rebase-merge` or `.git/rebase-apply`. If found, **STOP** and report.
- From the commit list: if 0 or 1 commits, report "nothing to squash" and stop.

### Step 3: Gather context

- Read all commits with full diffs: `git log <anchor>..HEAD --format='%H %s' --reverse` then `git show <sha>` for each
- Sanity-check scope: `git diff --stat <anchor>..HEAD` — this is the exact set of changes the squash must preserve. Compare it to your mental model of the branch; if files appear that you don't recognize as part of this branch's work, investigate before proceeding.
- Map which files and symbols each commit touches
- Trace dependencies: if commit A adds a function and commit B calls it, they're linked

## Phase 2 — Plan groups

Analyze commits and decide which ones belong together based on **code dependencies**:

1. **Build a dependency graph** — for each commit, identify what it introduces (new functions, exports, types, files) and what it consumes (calls, imports, references). Commits that produce/consume the same symbols are linked.
2. **Form groups** — connected commits become one group. Also merge:
   - Fix-then-fix-again → one fix
   - WIP/checkpoint commits → fold into the feature they belong to
   - Tests → group with the code they test
3. **Verify each group is self-contained** — mentally simulate: if this group's commit were reverted, would remaining commits still work? If not, the group boundary is wrong — merge the dependent groups.
4. **Order groups** — if group B depends on group A, A must come first. Independent groups go in logical order (infrastructure before features, setup before usage).

If all commits are already logically clean and independently revertable, report "nothing to squash — commits already clean" and stop.

## Phase 3 — Execute

Use the soft-reset pattern since interactive rebase is unavailable. Reset onto `<anchor>` (the merge-base SHA from Phase 1) — **never** onto `origin/<base>` directly, or you risk committing deletions of work that landed on the base while the branch existed.

Process groups from oldest to newest:

```bash
# Reset all commits to the merge-base anchor (NOT origin/<base>)
git reset --soft <anchor>

# Unstage everything
git reset HEAD .

# For each logical group, stage its files and commit:
git add <files-for-group-1>
git commit -m "type(scope): summary for group 1"

git add <files-for-group-2>
git commit -m "type(scope): summary for group 2"
# ... etc
```

If all commits collapse into a single group, the simpler pattern works:

```bash
git reset --soft <anchor>
git commit -m "type(scope): summary"
```

### Commit message rules

- Follow the `vigil-commit` skill format: `<type>(<scope>): <summary>`
- Synthesize a message per group — don't concatenate originals
- Keep first line under 72 characters
- Add body with bullet points if the group combined 3+ commits
- Preserve any `Co-Authored-By` trailers from original commits

## Phase 4 — Verify

### Step 1: Diff integrity

- `git diff --stat <anchor>..HEAD` — must match the Phase 1 Step 3 sanity-check output exactly. If not, **STOP** — something was lost or extra was pulled in.
- Also run `git diff --stat origin/<base>...HEAD` (three dots) as a cross-check — it should match too, since three-dot diff is also anchored on the merge-base.

### Step 2: Revertability check

For each new commit, verify it's revertable by reading the diff and confirming:

- No dangling references (calls to functions defined only in other new commits)
- No orphaned definitions (code that only makes sense with another commit present)
- Imports/exports are consistent within the commit

If a commit fails this check, go back and regroup.

### Step 3: Report

- `git log <anchor>..HEAD --oneline` — show new commit history
- Report: **"Squashed N commits into M"**
- If divergence was non-zero, also report: **"Branch is still behind `<base>` by X commits — run `vigil-rebase` skill if you want to catch up."**

## Edge Cases

- **Single commit on branch:** Nothing to squash. Report and stop.
- **No commits ahead of base:** Nothing to squash. Report and stop.
- **Uncommitted changes:** Commit first (via `vigil-commit` skill), then squash.
- **Already pushed:** Warn that squashing will require force-push to update remote. Proceed — the `vigil-push` skill handles force-push safely.
- **Merge commits on branch:** Warn that squash will flatten merge history. Proceed.
- **All commits already clean:** Report and stop — don't squash for the sake of it.
- **Branch diverged from base (base moved forward):** Handled by anchoring on the merge-base — do **not** mix in a rebase. If the user wants the branch caught up to `<base>`, hand off to the `vigil-rebase` skill after squashing.
- **No merge-base found:** Branch has no shared history with `<base>`. **STOP** and report — likely the wrong base.
