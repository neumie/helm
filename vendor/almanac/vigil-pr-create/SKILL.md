---
name: vigil-pr-create
description: "Use when creating a GitHub pull request. Pushes branch if needed, generates title + description from commits, creates PR via gh CLI. Triggers: create/open/submit PR."
compatibility: Requires gh CLI (GitHub CLI) for PR creation.
---

# Create PR

Push the branch and open a GitHub pull request with a well-crafted description.

## Phase 1 — Analyze

These commands run automatically when the skill loads — output replaces each line below:

- Working tree status: !`git status`
- Current branch: !`git branch --show-current`
- origin/main exists: !`git rev-parse --verify origin/main 2>/dev/null && echo main || true`
- origin/master exists: !`git rev-parse --verify origin/master 2>/dev/null && echo master || true`
- Tracking branch: !`git rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null || true`
- Existing PR: !`gh pr view --json number,state,url 2>/dev/null || true`

### Step 1: Detect the base branch

From the pre-run output, use `main` if it exists, otherwise `master`. Store as `<base>`.

### Step 2: Check prerequisites

- From `git status`: warn if uncommitted changes exist (suggest committing first using the vigil-commit skill)
- From `git branch --show-current`: confirm not on main/master — cannot create a PR from the base branch to itself
- From `gh pr view`: if state is `OPEN`, an open PR already exists — show URL and ask whether to update title/body. `MERGED`/`CLOSED` means create a new one.

### Step 3: Gather branch content

- `git log origin/<base>..HEAD --oneline` — all commits on the branch
- `git diff origin/<base>..HEAD --stat` — files changed summary
- `git diff origin/<base>..HEAD` — full diff for understanding
- Read changed files for context

### Step 4: Check unpushed commits

- If `@{u}` was empty: branch is not pushed, run `git push -u origin <branch>` in Phase 2.
- If `@{u}` exists: `git log @{u}..HEAD --oneline 2>/dev/null` to see unpushed commits.

### Step 5: Generate PR content

**Title:**
- Under 70 characters
- Clear description of what the PR does
- Use branch commits to determine if this is a feat, fix, refactor, etc.

**Body:**

```markdown
## Summary
<1-3 bullet points describing what this PR does and why>

## Changes
<grouped by logical feature, not by file>

## Test plan
<bulleted checklist of how to verify the changes work>
```

## Phase 2 — Execute

### Step 1: Push if needed

- If branch not pushed: `git push -u origin <branch-name>`
- If unpushed commits exist: `git push`

### Step 2: Create the PR

```bash
gh pr create --title "<title>" --body "$(cat <<'EOF'
## Summary
...

## Changes
...

## Test plan
...
EOF
)" --base <base>
```

If the user requested a draft: add `--draft` flag.

### Step 3: Report

- Show the PR URL
- Report: **"Created PR #N: `<title>` — `<url>`"**

## Edge Cases

- **Open PR already exists:** Show the URL. Ask if the user wants to update the title/body with `gh pr edit`.
- **Merged/closed PR exists for branch:** Treat as no PR — create a new one.
- **No commits on branch** (identical to base): Report and stop.
- **Branch has a generic name** (e.g. `temp`, `wip`, `test`, or auto-generated names): Suggest using the `vigil-branch-name` skill to rename it before creating the PR.
- **Not a GitHub repo:** Report error — this skill requires GitHub and the `gh` CLI.
- **gh CLI not installed:** Report error with install instructions (`brew install gh` or see https://cli.github.com).
- **Draft PR:** If user says "draft", add `--draft` flag to `gh pr create`.
- **Uncommitted changes:** Suggest using the vigil-commit skill first before creating the PR.
