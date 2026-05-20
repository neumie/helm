# Complex Execution

The task is large, ambiguous, or high-risk. Plan before you build.

## Steps

### Phase 1 — Deepen exploration

Build on the exploration done during assessment. Focus on what you still don't know:

- Read relevant modules end-to-end, not just the files already explored
- Understand data flow, dependencies, and existing patterns
- Identify what you don't know — list the unknowns

### Phase 2 — Resolve unknowns

For each unknown:

- **If answerable by reading code** — read the code. Don't ask the user what you can discover yourself.
- **If answerable only by the user** — ask a minimal, targeted question. Batch questions if possible (max 3 at a time). Don't ask about things the code already answers.

### Phase 3 — Plan

Write a structured implementation plan:

```
## Goal
<What this task accomplishes, in one sentence>

## Phases
1. <Phase name> — <what it does, which files>
2. <Phase name> — <what it does, which files>
...

## Files to change
- <path> — <what changes and why>

## Risks
- <What could go wrong and how to mitigate>

## Testing strategy
- <How to verify the changes work>
```

Announce the plan and ask: "Does this plan look right, or should I adjust before executing?" Wait for the user's response before proceeding.

### Phase 4 — Execute

Work through the plan phase by phase:

- Complete each phase fully before starting the next
- Run relevant tests after each phase
- If the plan needs adjustment based on what you discover, update it and note the deviation

### Phase 5 — Verify

- Run the full test suite
- Review the complete diff to check for anything missed
- Report what was done, including any deviations from the plan

## Rules

- The plan is a living document — update it when reality diverges
- Prefer asking the codebase over asking the user
- If exploration reveals this task should be decomposed into separate tasks, say so and propose the split
