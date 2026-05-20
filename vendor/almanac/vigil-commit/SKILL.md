---
name: vigil-commit
description: "Use when committing changes. Analyzes diff, writes a conventional commit message, commits immediately without confirmation. Triggers: commit, save my work, done with this change."
---

# Commit

Commit staged and unstaged changes following the rules below.

## Commit message format

Use semantic commit messages matching the project convention:

```
<type>(<scope>): <short summary in imperative mood>
```

Types: `feat`, `fix`, `refactor`, `perf`, `chore`, `ci`, `docs`, `test`

- Summary is lowercase, no period at the end
- Imperative mood ("add X", not "added X" or "adds X")
- Keep the first line under 72 characters
- Add a blank line + body only if the "why" isn't obvious from the summary

## Splitting into logical commits

- If you have context about what work was done (e.g. you just finished implementing something), commit **only** that work. Don't bundle unrelated changes — leave other unstaged/untracked changes alone.
- You MAY split your work into multiple logical commits if it makes sense (e.g. a refactor commit + a feature commit, or separating test changes from implementation).
- If you have no prior context, read `git diff` and `git diff --cached` to understand all changes, then group them into reasonable logical commits by topic/purpose. If some changes appear unrelated to each other and you can't determine what belongs together, ask before committing.
- Each commit should be self-contained and buildable on its own when possible.

## Procedure

These commands run automatically when the skill loads — output replaces each line below:

- Working tree status: !`git status`
- Unstaged diff: !`git diff`
- Staged diff: !`git diff --cached`
- Recent commits: !`git log --oneline -10`

Then:

1. Review the changes and decide how to split them into commits (if needed).
2. For each commit:
   - Stage the relevant files with `git add <specific files>` (never `git add -A` or `git add .`)
   - Create the commit
3. Run `git status` after all commits to verify nothing was missed.

## Edge cases

- **Nothing to commit:** Report and stop.
- **Pre-commit hook failure:** The commit did NOT happen. Fix the issue, re-stage, and create a **new** commit. Never use `--amend` after a hook failure — it would modify the previous commit.
- **Secrets / dangerous files:** If you spot `.env` files, API keys, tokens, credentials, or private keys, **stop** and warn before committing.
- **Merge conflict markers:** Warn and refuse to commit those files.
