---
name: vigil-ci-fix
description: "Use when GitHub Actions CI is failing on the current branch. Fetches latest failed run, reads logs, finds root cause, fixes it. Triggers: fix CI, pipeline broken, build red."
---

# Fix CI

Fetch the failing GitHub Actions logs, find the root cause, fix the code. No reports — just fix it.

## Process

### 1. Get the Failing Run

Pre-run on skill load — output replaces the line below:

- Most recent failed run: !`gh run list --branch "$(git branch --show-current)" --status failure --limit 1 --json databaseId,name,conclusion,headBranch,event,createdAt`

If the output is `[]`, no failed runs exist — tell the user and stop.

If the user specifies a particular run ID or workflow name, use that instead.

### 2. Read the Error Logs

Fetch only the failed step logs — this cuts noise dramatically:

```bash
gh run view <run-id> --log-failed
```

If the output is too large or unclear, drill into specific jobs:

```bash
gh run view <run-id> --json jobs --jq '.jobs[] | select(.conclusion == "failure") | {name, steps: [.steps[] | select(.conclusion == "failure") | {name, conclusion}]}'
```

Then fetch a specific job's failed logs:

```bash
gh run view <run-id> --job <job-id> --log-failed
```

### 3. Identify the Root Cause

Parse the error output. Common failure categories:

- **Test failure**: assertion error, test name, expected vs actual
- **Build/compile error**: file path, line number, error message
- **Lint/format error**: file path, rule name, violation
- **Dependency error**: missing package, version conflict
- **Timeout**: which step timed out, likely cause
- **Workflow config error**: YAML syntax, invalid action reference

Extract the key signal: file path, line number, error message, test name.

### 4. Read the Relevant Code

Read the files identified in the error logs. Always read the full file context around the error — don't guess from the log alone.

If the error references a test, read both the test file and the source file it tests.

If the error is a build or type error, read the file at the reported line and check imports, types, and function signatures.

### 5. Fix Minimally

Fix the root cause, not symptoms:
- Failing test → fix the code (or the test if the test is wrong)
- Build error → fix the type, import, or syntax issue
- Lint error → fix the violation, don't disable the rule
- Dependency error → update the dependency or lock file

Change as little as possible. Don't refactor, clean up, or improve unrelated code.

### 6. Verify Locally

Run the same check that failed, locally:
- Test failure → run the specific test
- Build error → run the build
- Lint error → run the linter

If you can't determine the local equivalent of the CI command, check the workflow YAML:

```bash
gh run view <run-id> --json workflowName --jq '.workflowName'
```

Then read `.github/workflows/<name>.yml` to find the exact command.

Tell the user the result. If it passes, you're done. If it fails with a different error, go back to step 3.

## Edge Cases

- **Flaky test**: If the error looks non-deterministic (timeout, network error, race condition), say so. Don't change code to work around flaky infrastructure.
- **Multiple failures**: Fix them in dependency order — a build error may cause downstream test failures. Fix the build first, then reassess.
- **Workflow YAML issue**: If the failure is in the workflow config itself (bad action version, missing secret, incorrect path), fix the YAML. But confirm with the user before changing CI configuration.
- **Permissions/secrets**: If the failure involves missing secrets or insufficient permissions, tell the user — you can't fix those.
