import type { SolverAgent } from './agent.js'

/**
 * Curated model catalog per agent CLI — the single source for every model
 * dropdown (dashboard Settings, extension quick-switch). Ids are passed
 * verbatim to the agent's `--model` flag, and the schema stays a free string,
 * so an id missing here still works — the catalog is UI sugar, not validation.
 * Keep ordered best-first; update when providers ship new models.
 */
export interface ModelOption {
	id: string
	label: string
}

export const MODEL_CATALOG: Record<SolverAgent, ModelOption[]> = {
	claude: [
		{ id: 'claude-fable-5', label: 'Fable 5' },
		{ id: 'claude-opus-5', label: 'Opus 5' },
		{ id: 'claude-opus-4-8', label: 'Opus 4.8' },
		{ id: 'claude-sonnet-5', label: 'Sonnet 5' },
		{ id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
	],
	codex: [
		// GPT-5.6 family (GA 2026-07-09): Sol > Terra > Luna by capability/price.
		{ id: 'gpt-5.6-sol', label: 'Sol' },
		{ id: 'gpt-5.6-terra', label: 'Terra' },
		{ id: 'gpt-5.6-luna', label: 'Luna' },
		{ id: 'gpt-5.5', label: 'GPT-5.5' },
	],
	// Pi spans providers; qualified ids make the owning subscription explicit.
	pi: [
		{ id: 'anthropic/claude-fable-5', label: 'Anthropic · Fable 5' },
		{ id: 'anthropic/claude-opus-5', label: 'Anthropic · Opus 5' },
		{ id: 'anthropic/claude-opus-4-8', label: 'Anthropic · Opus 4.8' },
		{ id: 'anthropic/claude-sonnet-5', label: 'Anthropic · Sonnet 5' },
		{ id: 'anthropic/claude-haiku-4-5', label: 'Anthropic · Haiku 4.5' },
		{ id: 'openai-codex/gpt-5.6-sol', label: 'OpenAI Codex · Sol' },
		{ id: 'openai-codex/gpt-5.6-terra', label: 'OpenAI Codex · Terra' },
		{ id: 'openai-codex/gpt-5.6-luna', label: 'OpenAI Codex · Luna' },
		{ id: 'openai-codex/gpt-5.5', label: 'OpenAI Codex · GPT-5.5' },
	],
}

/** Return the owning CLI for a curated model id; custom ids remain unresolved. */
export function agentForModel(model: string | undefined): SolverAgent | undefined {
	if (!model) return undefined
	for (const agent of ['claude', 'codex', 'pi'] satisfies SolverAgent[]) {
		if (MODEL_CATALOG[agent].some(option => option.id === model)) return agent
	}
	return undefined
}

/** Default model for the cheap AI-helper one-shots (naming/triage). */
export function defaultHelperModel(agent: SolverAgent | undefined): string {
	switch (agent) {
		case 'codex':
			return 'gpt-5.6-luna'
		case 'pi':
			return 'anthropic/claude-haiku-4-5'
		default:
			return 'claude-haiku-4-5'
	}
}

/**
 * Resolve a helper invocation as one agent/model pair. A known curated model
 * owns its CLI, preventing e.g. `claude --model gpt-*`; unknown custom model
 * ids continue to honor the configured provider.
 */
export function resolveHelperInvocation(
	configuredAgent: SolverAgent | undefined,
	fallbackAgent: SolverAgent | undefined,
	configuredModel: string | undefined,
): { agent: SolverAgent; model: string } {
	const agent = agentForModel(configuredModel) ?? configuredAgent ?? fallbackAgent ?? 'claude'
	return { agent, model: configuredModel ?? defaultHelperModel(agent) }
}

export function agentModelLabel(agent: SolverAgent): string {
	switch (agent) {
		case 'claude':
			return 'Claude'
		case 'codex':
			return 'Codex'
		case 'pi':
			return 'Pi'
	}
}

/**
 * Model-tier guidance injected into the solve prompt: how the agent should
 * SPEND the model it runs on. A premium tier (Fable) should orchestrate —
 * delegate grunt work to subagents and keep its own context for judgment; a
 * budget tier should stay narrow and flag scope creep instead of thrashing.
 * Keyed by exact model id from {@link MODEL_CATALOG}; an unknown/unset model
 * (agent CLI default) gets no extra guidance.
 */
export const DEFAULT_MODEL_GUIDANCE: Record<string, string> = {
	'claude-fable-5': [
		'You are running as Fable 5 — the most capable and most EXPENSIVE tier. Spend it like an orchestrator:',
		'- Fan out subagents (the Task tool) for codebase exploration, broad searches, and mechanical multi-file edits; give them crisp, self-contained briefs.',
		'- Keep your own context for architecture, tricky diagnosis, and reviewing what subagents return.',
		'- Prefer one decisive, correct pass over cheap trial-and-error; verify with tools instead of re-deriving from memory.',
	].join('\n'),
	'claude-opus-5': [
		'You are running as Opus 5 — a premium tier that is strongest on long-horizon, multi-file work. Take the whole task in one decisive pass:',
		'- Delegate sparingly: a subagent (the Task tool) pays off only for genuinely independent, sizeable tracks — never for work you could finish in a handful of tool calls, and never to verify your own work.',
		'- You already verify as you go; do not add a separate double-check pass on top of it.',
		'- Deliver exactly the requested scope. If a better approach exists, say so in one line in the solver-result.json summary and keep going with the task as asked.',
	].join('\n'),
	'claude-opus-4-8': [
		'You are running as Opus 4.8 — a strong premium tier. Delegate broad exploration and mechanical sweeps to subagents (the Task tool); do the design, tricky edits, and verification yourself.',
	].join('\n'),
	'claude-sonnet-5':
		'You are running as Sonnet 5 — a balanced tier. Work directly; use subagents only for genuinely parallel exploration.',
	'claude-haiku-4-5': [
		'You are running as Haiku 4.5 — a fast, budget tier. Keep the change tightly scoped and mechanical.',
		'If the task turns out to be architectural, ambiguous, or larger than it looked, do NOT guess — say so in the solver-result.json summary and stop.',
	].join('\n'),
	'gpt-5.6-sol': [
		'You are running as Sol (GPT-5.6) — the most capable and most EXPENSIVE tier. One decisive, deeply verified pass:',
		'- Plan briefly, then execute without thrash; verify with tools instead of re-deriving from memory.',
		'- Your output tokens are costly — no padding, no redundant re-reads of files you have already seen.',
	].join('\n'),
	'gpt-5.6-terra':
		'You are running as Terra (GPT-5.6) — a balanced tier. Work directly and verify with the test suite before shipping.',
	'gpt-5.6-luna': [
		'You are running as Luna (GPT-5.6) — a fast, budget tier. Keep the change tightly scoped and mechanical.',
		'If the task turns out to be architectural, ambiguous, or larger than it looked, do NOT guess — say so in the solver-result.json summary and stop.',
	].join('\n'),
	'gpt-5.5':
		'You are running as GPT-5.5 — a strong premium tier. Plan briefly, then make one decisive, well-verified pass; avoid redundant re-reads of files you have already seen.',
}

const PI_MODEL_GUIDANCE: Record<string, string> = {
	'anthropic/claude-fable-5':
		'Pi is running Fable 5 — use this expensive tier for architecture and judgment, delegate only through extensions or tools that are actually available, and verify decisively.',
	'anthropic/claude-opus-5':
		'Pi is running Opus 5 — take the whole task in one decisive pass, verify as you go instead of adding a separate check pass, and deliver exactly the requested scope.',
	'anthropic/claude-opus-4-8':
		'Pi is running Opus 4.8 — keep broad exploration structured, do the tricky reasoning directly, and verify the complete change.',
	'anthropic/claude-sonnet-5':
		'Pi is running Sonnet 5 — work directly, stay scoped, and use available skills when they materially reduce risk.',
	'anthropic/claude-haiku-4-5':
		'Pi is running Haiku 4.5 — keep the change tightly scoped and stop with an honest summary if it becomes architectural or ambiguous.',
	'openai-codex/gpt-5.6-sol': DEFAULT_MODEL_GUIDANCE['gpt-5.6-sol'],
	'openai-codex/gpt-5.6-terra': DEFAULT_MODEL_GUIDANCE['gpt-5.6-terra'],
	'openai-codex/gpt-5.6-luna': DEFAULT_MODEL_GUIDANCE['gpt-5.6-luna'],
	'openai-codex/gpt-5.5': DEFAULT_MODEL_GUIDANCE['gpt-5.5'],
}

/**
 * Guidance for the model the run will actually use, or null when unknown/
 * default. A Settings override (`solver.modelGuidance[model]`) wins over the
 * built-in default; a blank override falls back to the default.
 */
export function modelGuidance(model: string | undefined, overrides?: Record<string, string>): string | null {
	if (!model) return null
	return overrides?.[model] || DEFAULT_MODEL_GUIDANCE[model] || PI_MODEL_GUIDANCE[model] || null
}

/**
 * Flat select options across all agents (Settings model dropdowns aren't
 * agent-scoped — the sibling Provider field can change independently).
 */
export function modelSelectOptions(): Array<{ value: string; label: string }> {
	const agents: SolverAgent[] = ['claude', 'codex', 'pi']
	return agents.flatMap(agent =>
		MODEL_CATALOG[agent].map(m => ({ value: m.id, label: `${agentModelLabel(agent)} · ${m.label}` })),
	)
}
