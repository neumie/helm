import { planPaths } from '../plan/workspace.js'
import type { TaskContext } from '../providers/provider.js'
import { type PlanContext, buildTaskContext } from '../task-context.js'

function solverInstructions(planDirName: string): string {
	return `You are solving a task from a project management system. The task may be written in any language — understand it regardless.

Follow the /almanac:task-start skill to begin. This will guide you through exploration, complexity assessment, and execution.

IMPORTANT: If the task context lists any attachments, always fetch and review them before starting — they often contain screenshots, mockups, logs, or specs that are essential to understanding the task.

IMPORTANT: If the task affects UI behaviour (which most of these do), verify the fix end-to-end with \`agent-browser\` before shipping — navigate to the relevant page, reproduce the scenario from the task, and confirm the new behaviour matches what was requested. Do not claim a UI task is done without having seen it work in the browser.

IMPORTANT: Always rename the branch using /almanac:branch-name — the auto-generated branch name is not descriptive.

When the implementation is complete, use /almanac:ship to create the PR. Do NOT create a draft — create a regular PR.

## Additional rules for automated solving

After shipping, write a \`solver-result.json\` file at \`${planPaths(planDirName).result}\` (the directory already exists; do not create a sibling at the repo root):

\`\`\`json
{
  "summary": "Brief description of what was done",
  "filesChanged": ["path/to/file1.ts", "path/to/file2.ts"],
  "prTitle": "Suggested PR title",
  "prBody": "Suggested PR body in markdown",
  "prUrl": "https://github.com/... (only if you shipped a PR via /almanac:ship)"
}
\`\`\`

If you created a PR via /almanac:ship, include the PR URL in \`prUrl\`.
Use /almanac:commit for all commits.

### Critical rules:
- NEVER change code that works correctly unless the task specifically asks for it
- NEVER add features, refactor, or "improve" beyond what was requested
- NEVER commit files you didn't intentionally change
- If you cannot verify the described issue exists, say so in the summary rather than guessing

---

`
}

/**
 * Short, CLI-safe planning instructions passed to the agent as a single
 * shell arg. The task context is NOT inlined — it lives at
 * `docs/plans/<planDirName>/context.md` and the agent reads it from disk.
 * Avoid backticks and dollar signs so the okena run_command shell layer
 * doesn't try to expand them.
 */
export function buildPlanningPrompt(planDirName: string): string {
	// Only `planDirName` is interpolated — and it's slugified (alphanumeric +
	// dashes), so safe to embed in a shell command without escaping. No user-
	// controlled content (the task title etc. lives in context.md).
	const paths = planPaths(planDirName)
	return [
		'You are helping the user plan a task before it gets solved autonomously.',
		'',
		'Your first job is to UNDERSTAND THE TASK DEEPLY. Do not rush to greet the user.',
		'',
		`Step 1 — read the task context at ${paths.context}.`,
		'',
		'Step 2 — if the context lists any attachments (screenshots, mockups, logs, specs), fetch and review them inline (read or view via the URL). DO NOT download or save them to disk — no attachments/ folder, no copies in the worktree. They are referenced by URL and that is enough.',
		'',
		'Step 3 — if the task touches UI behaviour, use agent-browser to navigate to the relevant page and observe the current behaviour with your own eyes. Reproducing the scenario at plan time is much cheaper than discovering misunderstandings during the autonomous solve.',
		'',
		"Step 4 — explore the codebase briefly to understand the surface area touched. Grep for terms from the task, read files likely to be involved. Don't go deep — deep dives belong to the planning skills below.",
		'',
		'Step 5 — ONLY now greet the user. Give a 2-3 sentence summary of what you understand (including anything surprising the attachments or codebase revealed) and ask what they want to do. Options:',
		`- /grill-me ${planDirName} for interactive decision stress-testing (writes brief.md)`,
		`- /grill-plan ${planDirName} to challenge the plan against the domain model`,
		'- /prd-create to synthesize a PRD',
		'- /almanac:complexity-assess to rate scope and risk',
		'- just talk it through',
		'',
		'Wait for direction. Do not write artifacts unsolicited. Do not ship code or commit changes — planning only.',
		`Anything you write should land under ${paths.dir}/.`,
		'',
		'When the user is done, they trigger the autonomous run from the Vigil extension.',
	].join('\n')
}

export function buildPrompt(task: TaskContext, ctx: PlanContext): string {
	const taskContextStr = buildTaskContext(task, ctx)
	return `${solverInstructions(ctx.planDirName)}## Task Context\n\n${taskContextStr}`
}
