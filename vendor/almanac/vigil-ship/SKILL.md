---
name: vigil-ship
description: "Use when shipping work end-to-end. Names branch, commits, pushes, creates PR — no confirmation. Triggers: ship, ship it, send it, go from uncommitted changes to open PR."
metadata:
  dependencies:
    - vigil-branch-name
    - vigil-commit
    - vigil-commits-squash
    - vigil-push
    - vigil-pr-create
---

# Ship

Run the full workflow: name the branch, commit, push, and open a PR. Each step runs unconditionally — the step itself decides whether to act or skip. Stop immediately if any step fails.

If the user says "ship draft" or "draft", create the PR as a draft.

## Pre-run state

These commands run automatically when the skill loads — output replaces each line below:

- Working tree status: !`git status`
- Current branch: !`git branch --show-current`
- Workflow count: !`gh api repos/{owner}/{repo}/actions/workflows --jq '.total_count' 2>/dev/null || true`

## Step 1 — Name the branch

Follow the `vigil-branch-name` skill to analyze the branch contents and rename if needed.

- If the branch already has a good descriptive name (matches `<type>/<description>` pattern and accurately describes the work), keep it.
- Otherwise, the `vigil-branch-name` skill will rename it.

### Record

Note for the summary: `Branch: <name>` (or `Branch: <name> (kept)` if unchanged).

## Step 2 — Commit

Follow the `vigil-commit` skill to analyze changes and create commits.

If there are no staged or unstaged changes, skip this step. Record: `Commit: nothing to commit (skipped)`.

### Record

Note for the summary: `Commit: "<message>"` (or multiple lines if split into multiple commits).

## Step 3 — Squash commits

Follow the `vigil-commits-squash` skill to combine related commits into logical groups. If there are 0 or 1 commits, or commits are already clean, the skill will skip automatically.

### Record

Note for the summary: `Squash: N commits into M` (or `Squash: already clean (skipped)`).

## Step 4 — Push

Follow the `vigil-push` skill to push the branch to remote safely. It will handle tracking, safety checks, and updating any open PR description.

### Record

Note for the summary: `Push: N commits to origin/<branch>` (or `Push: already up to date (skipped)`). If PR was updated: `PR #N: description updated`.

## Step 5 — Create PR

Follow the `vigil-pr-create` skill to create the pull request. If the user requested a draft, pass that through.

If an **open** PR already exists, skip creation. Record: `PR: #N already exists — <url>`.

### Record

Note for the summary: `PR: Created #N — <url>` (add `(draft)` if applicable).

## Final Summary

After all steps complete, print a compact summary:

```
Shipped:
  Branch: feat/add-user-avatar
  Commit: "feat(avatar): add upload endpoint"
  Squash: 5 commits into 2
  Push: 1 commit to origin/feat/add-user-avatar
  PR: Created #42 — https://github.com/org/repo/pull/42
```

Replace any skipped steps with their skip message (e.g., `Commit: nothing to commit (skipped)`).

After the summary, use the workflow count from the pre-run:

- If workflows exist (count > 0): invoke the `vigil-pr-watch` skill on the PR immediately — do not ask.
- If no workflows (count is 0): ask **"Merge?"** — if yes, try `gh pr merge <number> --squash --delete-branch`. If it fails (e.g., git worktree conflict), merge via API: `gh api repos/{owner}/{repo}/pulls/{number}/merge -X PUT -f merge_method=squash`, then delete the remote branch: `gh api repos/{owner}/{repo}/git/refs/heads/{branch} -X DELETE`.
