---
name: vigil-complexity-assess
description: "Use when scoring how complex a task is before starting. Rates scope, clarity, risk, novelty into a tier (trivial/moderate/complex). Triggers: complexity check, how hard is this."
---

# Complexity Assessment

Evaluate a task's complexity using a structured heuristic. This is a pure analysis skill — it reports a tier and rationale but does NOT execute anything.

## Process

1. **Read the task description** — what the user wants to accomplish
2. **Explore the codebase** — grep for relevant terms, read related files, understand what's involved. When invoked from `vigil-task-start`, exploration has already been done — use those findings directly rather than re-exploring.
3. **Score each dimension** (see heuristic below) with a one-line justification
4. **Report the tier** and recommended approach

## Heuristic

Score each dimension 1-3:

### Scope — How many files and modules are affected?

- **1**: 1-3 files in one module
- **2**: 4-15 files or 2-3 modules
- **3**: 15+ files or 4+ modules or new module creation

### Clarity — How specific is the task?

- **1**: Exact file, function, or error referenced
- **2**: Clear goal, but approach needs figuring out
- **3**: Vague goal, significant design decisions needed

### Risk — What breaks if this goes wrong?

- **1**: Isolated, easily reversible
- **2**: Touches shared code or has moderate blast radius
- **3**: Auth, payments, data integrity, or public API changes

### Novelty — Has the codebase done this before?

- **1**: Pattern already exists, just replicate
- **2**: Extends existing patterns in new directions
- **3**: No precedent in the codebase

## Tiers

| Total Score | Tier | Meaning |
|-------------|------|---------|
| 4-5 | **Trivial** | Straightforward — just do it |
| 6-8 | **Moderate** | Multi-step — break it down and work through sequentially |
| 9-12 | **Complex** | Significant — plan first, then execute phase by phase |

## Output Format

```
## Complexity: <TIER> (score: <N>/12)

| Dimension | Score | Rationale |
|-----------|-------|-----------|
| Scope     | <1-3> | <one line> |
| Clarity   | <1-3> | <one line> |
| Risk      | <1-3> | <one line> |
| Novelty   | <1-3> | <one line> |

Recommended: <one-line approach based on tier>
```

## Rules

- Always explore the codebase before scoring — don't guess from the task description alone
- Be honest about uncertainty — if you can't determine scope without deeper exploration, that itself suggests higher complexity
- Scores should reflect the actual codebase state, not abstract difficulty
- This skill can be invoked standalone ("how complex would X be?") or as part of `vigil-task-start`
