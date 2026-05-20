---
name: vigil-branch-name
description: "Use when naming or renaming the current git branch from its contents. Triggers: name this branch, rename branch, or working on default branch (main) with uncommitted work."
---

# Branch Name

Generate a descriptive branch name from the branch's contents and rename the current branch.

## What to analyze

These commands run automatically when the skill loads — their output replaces each line below. Use whatever has content.

- Staged file list: !`git diff --cached --stat`
- Staged diff: !`git diff --cached`
- Unstaged file list: !`git diff --stat`
- Unstaged diff: !`git diff`
- Branch commits: !`git log main..HEAD --oneline 2>/dev/null || git log master..HEAD --oneline 2>/dev/null || true`
- Commit messages: !`git log main..HEAD --format="%B" 2>/dev/null || git log master..HEAD --format="%B" 2>/dev/null || true`

If on main/master with uncommitted changes, only the diff output will be useful.

## Naming rules

- Format: `<type>/<short-description>` where type is `feat`, `fix`, `refactor`, `chore`, `docs`, `test`, `ci`, or `perf`
- Use lowercase kebab-case for the description
- Keep total length under 50 characters
- Be specific: `feat/add-user-avatar-upload` not `feat/update-users`
- Use imperative mood: `fix/handle-null-response` not `fix/handled-null-response`
- No issue numbers unless the user asks for them

## Procedure

1. Analyze the branch contents (diffs and/or commits as above).
2. Determine the primary type from the changes.
3. Generate the branch name.
4. Present the name and rename:

```bash
git branch -m <new-name>
```

5. After renaming, check if the old branch had a remote tracking branch:

```bash
git for-each-ref --format='%(upstream:short)' refs/heads/<new-name>
```

If a remote tracking branch exists, rename the remote branch using GitHub's API (this preserves any open PRs):

```bash
gh api -X POST repos/{owner}/{repo}/branches/<old-name>/rename -f new_name="<new-name>"
git branch -u origin/<new-name>
```

If the `gh` command fails (e.g. not a GitHub repo), fall back to:

```bash
git push -u origin <new-name> && git push origin :<old-name>
```

## Edge cases

- **No changes and no commits:** Use the current conversation context (task description, discussed goals) to derive the branch name. If there is no conversation context either, report "nothing to name — no context available" and stop.
- **On `main`/`master`:** Create a new branch instead of renaming: `git checkout -b <name>`
- **Already on a well-named branch:** Suggest keeping it, or offer the new name as an alternative.
- **Detached HEAD:** Report error — must be on a branch to rename.
- **Mixed change types:** Use the dominant type. If truly split, suggest the user commit separately and name after the primary purpose.
