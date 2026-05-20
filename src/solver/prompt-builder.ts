import type { TaskContext } from '../providers/provider.js'
import { getTransformer, type TransformerContext } from '../transformers/transformer.js'

function solverInstructions(planDirName: string): string {
	return `You are solving a task from a project management system. The task may be written in any language — understand it regardless.

Follow the /almanac:task-start skill to begin. This will guide you through exploration, complexity assessment, and execution.

IMPORTANT: If the task context lists any attachments, always fetch and review them before starting — they often contain screenshots, mockups, logs, or specs that are essential to understanding the task.

IMPORTANT: If the task affects UI behaviour (which most of these do), verify the fix end-to-end with \`agent-browser\` before shipping — navigate to the relevant page, reproduce the scenario from the task, and confirm the new behaviour matches what was requested. Do not claim a UI task is done without having seen it work in the browser.

IMPORTANT: Always rename the branch using /almanac:branch-name — the auto-generated branch name is not descriptive.

When the implementation is complete, use /almanac:ship to create the PR. Do NOT create a draft — create a regular PR unless the task is complex.

## Additional rules for automated solving

After shipping, write a \`solver-result.json\` file at \`docs/plans/${planDirName}/solver-result.json\` (the directory already exists; do not create a sibling at the repo root):

\`\`\`json
{
  "tier": "trivial|simple|complex|unclear",
  "confidence": 0.0-1.0,
  "summary": "Brief description of what was done or analyzed",
  "filesChanged": ["path/to/file1.ts", "path/to/file2.ts"],
  "analysis": "Detailed analysis (for complex/unclear tiers)",
  "questionsForRequester": ["Question 1?", "Question 2?"],
  "remainingWork": ["Item 1", "Item 2"],
  "prReady": true|false,
  "prTitle": "Suggested PR title",
  "prBody": "Suggested PR body in markdown"
}
\`\`\`

If you created a PR via /almanac:ship, set \`prReady: true\` and include the PR URL in \`prUrl\`.
Use /almanac:commit for all commits.
Map tiers: trivial → prReady: true, simple/moderate → prReady: true, complex → prReady: false, unclear → prReady: false (no code changes).

### Critical rules:
- NEVER change code that works correctly unless the task specifically asks for it
- NEVER add features, refactor, or "improve" beyond what was requested
- NEVER commit files you didn't intentionally change
- If you cannot verify the described issue exists, classify as UNCLEAR and list questions

---

`
}

function planningInstructions(planDirName: string): string {
	return `You are helping the user PLAN a task before it gets solved autonomously. This is an interactive session — chat with the user, don't take actions on your own.

Briefly read the codebase to understand the surface area touched by this task (don't go deep — exploration is for the planning skills below).

Then greet the user with a 2-3 sentence summary of what you understand about the task, and ASK what they want to do. Options to surface:

- Run \`/grill-me ${planDirName}\` to stress-test decisions interactively. Writes \`docs/plans/${planDirName}/brief.md\`.
- Run \`/grill-plan ${planDirName}\` to challenge their plan against the existing domain model.
- Run \`/prd-create\` once they have a brief, to synthesize a PRD into \`docs/plans/${planDirName}/prd.md\`.
- Run \`/almanac:complexity-assess\` to rate scope/risk.
- Just talk through it conversationally.

WAIT for direction. Don't start grilling or writing artifacts unsolicited. If the user gives a vague answer, ask one targeted clarifying question.

Everything the user decides should land under \`docs/plans/${planDirName}/\` — that's where the autonomous solver reads from when the task runs. Skills like \`/grill-me\` and \`/prd-create\` write there automatically when invoked with the name argument.

Do NOT run \`/almanac:ship\` or commit code changes in this session. Planning only.

When the user is done planning, tell them they can trigger the autonomous run from the Vigil dashboard / extension.

---

`
}

export function buildPlanningPrompt(task: TaskContext, transformerName: string, ctx: TransformerContext): string {
	const transformer = getTransformer(transformerName)
	const taskContextStr = transformer(task, ctx)
	return `${planningInstructions(ctx.planDirName)}## Task Context\n\n${taskContextStr}`
}

const CHAT_INSTRUCTIONS = `You are assessing a task from a project management system before it gets solved. Read the codebase to understand the project structure and context.

Your job is to determine if the task description is clear enough to implement. If not, use the Vigil MCP tools to chat with the requester and get clarification.

IMPORTANT: If the task context lists any attachments, fetch and review them before deciding — screenshots, mockups, or specs may resolve ambiguity that the text alone leaves open.

## If the task is clear enough to implement:

Output ONLY this JSON:
{"chatNeeded": false, "reason": "Brief explanation of why the task is clear"}

## If the task is too vague or ambiguous:

Use the vigil MCP tools to chat with the requester:
1. Call vigil_create_chat with the task ID and title
2. Call vigil_send_message to ask clarifying questions — this blocks until the requester responds
3. Continue asking follow-ups until you have enough context
4. When you're confident you understand the task, ask the requester to confirm you should proceed
5. Call vigil_end_chat to close the session

Then output this JSON with the full conversation in your own words:
{"chatNeeded": true, "transcript": "## Clarification Conversation\\n\\n...your transcript..."}

## Rules:
- Be friendly and professional — the requester is a client
- Ask specific, targeted questions — not generic "can you tell me more?"
- Use your understanding of the codebase to ask informed questions
- One or two questions per message is ideal
- Write the transcript in your own words — summarize the conversation clearly

---

`

export function buildChatPrompt(task: TaskContext, taskId: string, transformerName: string, ctx: TransformerContext): string {
	const transformer = getTransformer(transformerName)
	const taskContextStr = transformer(task, ctx)
	return `${CHAT_INSTRUCTIONS}## Task ID: ${taskId}\n\n## Task Context\n\n${taskContextStr}`
}

export function buildPrompt(task: TaskContext, transformerName: string, ctx: TransformerContext): string {
	const transformer = getTransformer(transformerName)
	const taskContextStr = transformer(task, ctx)
	return `${solverInstructions(ctx.planDirName)}## Task Context\n\n${taskContextStr}`
}
