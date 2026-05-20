---
name: vigil-pr-watch
description: "Use when waiting for CI checks on a PR. Watches status, auto-fixes failures via ci-fix (max 2 retries), reports merge-ready. Triggers: watch PR, watch CI, wait for checks."
metadata:
  dependencies:
    - vigil-ci-fix
---

# PR Watch

Watch a PR's CI checks until they complete. If checks fail, attempt to fix them automatically. Report the result with a suggested next step.

## Detect the PR and CI

These commands run automatically when the skill loads — output replaces each line below:

- PR for current branch: !`gh pr view --json number,title,url,state,headRefName 2>/dev/null || true`
- Workflow count: !`gh api repos/{owner}/{repo}/actions/workflows --jq '.total_count' 2>/dev/null || true`

If the user provides a PR number, use that instead of the detected one.

If no PR exists or state is not `OPEN`, stop and report.

## Check for CI

If the workflow count is 0, report and suggest merge:

```
No CI workflows configured — nothing to watch.
Ready to merge: gh pr merge #42 --squash --delete-branch
```

## Watch Checks

Run:

```bash
gh pr checks --watch --interval 30
```

This blocks until all checks complete.

## Evaluate Results

After checks finish, get the full status:

```bash
gh pr checks --json name,state,conclusion
```

### All checks passed

Report and suggest merge:

```
Watching PR #42 (feat/add-tdd-and-test-write-skills)...
  CI: 5/5 passed

Result: All checks passed
Ready to merge: gh pr merge #42 --squash --delete-branch
```

### Some checks failed (fix attempts remaining)

If this is the 1st or 2nd failure, attempt an automatic fix:

1. Identify the failing checks from the output
2. Run the vigil-ci-fix workflow:
   - Fetch the failing run logs
   - Read the error output
   - Find and fix the root cause in the code
   - Commit and push the fix
3. Re-watch: run `gh pr checks --watch --interval 30` again

Track fix attempts. Maximum 2 fix attempts total.

```
Watching PR #42...
  CI: 1/5 failed (test-unit)
  Running ci-fix... fixed and pushed
  Re-watching...
  CI: 5/5 passed

Result: All checks passed (1 fix applied)
Ready to merge: gh pr merge #42 --squash --delete-branch
```

### Some checks failed (no fix attempts remaining)

If 2 fix attempts have been made and checks still fail, stop and report:

```
Watching PR #42...
  CI: 1/5 failed (test-unit)
  Running ci-fix... fixed and pushed (attempt 1)
  Re-watching...
  CI: 1/5 failed (test-unit)
  Running ci-fix... fixed and pushed (attempt 2)
  Re-watching...
  CI: 1/5 failed (test-unit)

Result: 1/5 checks still failing after 2 fix attempts
  FAIL: test-unit
Needs manual investigation.
```

## Rules

- Never merge the PR automatically during watching — only report and suggest
- Maximum 2 vigil-ci-fix attempts to prevent infinite loops
- If vigil-ci-fix itself fails (can't identify the issue), stop and report immediately
- Each fix attempt gets its own commit (never amend)
- If the PR is closed or merged while watching, stop and report the new state

## Merge Procedure

When the user asks to merge after watching:

1. Try `gh pr merge <number> --squash --delete-branch`
2. If it fails (e.g., git worktree conflict), merge via API instead:
   ```bash
   gh api repos/{owner}/{repo}/pulls/{number}/merge -X PUT -f merge_method=squash
   gh api repos/{owner}/{repo}/git/refs/heads/{branch} -X DELETE
   ```
