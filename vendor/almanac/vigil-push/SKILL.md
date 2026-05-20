---
name: vigil-push
description: "Use when pushing commits to a remote. Checks tracking, shows what will be pushed, sets upstream if needed, handles diverged branches safely. Triggers: push, prepare for PR."
---

# Push

Push the current branch to remote safely.

## Phase 1 — Analyze

### Step 1: Check current state and tracking

These commands run automatically when the skill loads — output replaces each line below:

- Working tree status: !`git status`
- Current branch: !`git branch --show-current`
- Recent commits: !`git log --oneline -5`
- Tracking branch: !`git rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null || true`
- Open PR: !`gh pr view --json number,title,url,state 2>/dev/null || true`

From the output:

- Warn if there are uncommitted changes (dirty working tree)
- Note the current branch name and recent commits
- If `@{u}` returned a tracking branch, note it
- If the tracking branch is not `origin/<current-branch>`, treat it like a mismatched upstream that must be repaired on push
- If `@{u}` was empty, upstream will be set on push
- If `gh pr view` returned an open PR, you'll update its description after pushing

### Step 3: Determine what will be pushed

- If tracking exists: `git log @{u}..HEAD --oneline` — unpushed commits
- If no tracking: `git log origin/main..HEAD --oneline` (or `origin/master`) — all branch commits

### Step 4: Safety checks

- **main/master branch:** Regular push is fine. Force-push is **NEVER** allowed — refuse and explain why.
- **Diverged branch:** `git status` shows "diverged" — warn and suggest rebasing first (use the vigil-rebase skill).
- **Force-push requested:** Warn explicitly that this rewrites remote history. If target is main/master, **REFUSE**. For other branches, proceed only with `--force-with-lease` (never bare `--force`).

## Phase 2 — Execute

### Step 1: Push

- If tracking is exactly `origin/<branch-name>`: `git push`
- If no tracking exists, or tracking points somewhere else such as `origin/main`: `git push -u origin HEAD:refs/heads/<branch-name>`
- If user confirmed force (non-main): `git push --force-with-lease`

### Step 2: Update PR description (if open PR exists)

After pushing, check if there's an open PR for this branch:

```bash
gh pr view --json number,title,url,state 2>/dev/null
```

If an **open** PR exists (state is `OPEN` — ignore `MERGED` or `CLOSED` PRs):

1. Gather the full branch content against the base:
   - `git log origin/<base>..HEAD --oneline` — all commits
   - `git diff origin/<base>..HEAD --stat` — files changed summary
   - `git diff origin/<base>..HEAD` — full diff for understanding
   - Read changed files for context
2. Generate an updated PR body using the same format as the `vigil-pr-create` skill:
   ```markdown
   ## Summary
   <1-3 bullet points describing what this PR does and why>

   ## Changes
   <grouped by logical feature, not by file>

   ## Test plan
   <bulleted checklist of how to verify the changes work>
   ```
3. Update the PR:
   ```bash
   gh pr edit <number> --body "$(cat <<'EOF'
   ...
   EOF
   )"
   ```
4. Also update the PR title if the scope of the branch has changed significantly.

If no PR exists, skip this step.

### Step 3: Verify

- Confirm push succeeded
- Report: **"Pushed N commits to origin/`<branch>`"**
- If PR was updated, report: **"Updated PR #N description"**

## Edge Cases

- **Nothing to push** (up to date): Report and stop.
- **Diverged branch:** Suggest rebase first. Do not force-push without explicit user request.
- **Push rejected** (non-fast-forward): Explain the situation, suggest pulling or rebasing.
- **No remote configured:** Report error, suggest `git remote add origin <url>`.
- **Authentication failure:** Report and suggest checking credentials or SSH keys.
