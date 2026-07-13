import { z } from 'zod'
import { configSchema } from './config.js'
import type { HelmConfig } from './config.js'
import { DEFAULT_ASSESSMENT_INSTRUCTIONS } from './items/assess.js'
import { DEFAULT_DISPLAY_INSTRUCTIONS, DEFAULT_NAMING_INSTRUCTIONS } from './items/naming.js'
import { DEFAULT_MODEL_GUIDANCE, MODEL_CATALOG, defaultHelperModel, modelSelectOptions } from './solver/models.js'
import type { ModelOption } from './solver/models.js'
import { listSpawnerAdapters } from './spawner/registry.js'
import type { SpawnerAdapterInfo } from './spawner/registry.js'

export const CONFIG_SECRET_REDACTION = '********'

export type ConfigFieldInput = 'text' | 'password' | 'number' | 'boolean' | 'select' | 'color' | 'textarea'

// The four editable controls every AI helper (branch naming / display name /
// triage) shares: on/off, provider override, model override, and a custom
// instruction prompt (blank → the built-in default, shown as the placeholder).
function aiHelperControls(base: string[], promptDefault: string): ConfigEditFieldControl[] {
	return [
		{ type: 'field', path: [...base, 'enabled'], label: 'Enabled', input: 'boolean' },
		{
			type: 'field',
			path: [...base, 'agent'],
			label: 'Provider',
			input: 'select',
			options: [
				{ value: '', label: 'Use solver agent' },
				{ value: 'claude', label: 'Claude Code' },
				{ value: 'codex', label: 'Codex' },
			],
		},
		{
			type: 'field',
			path: [...base, 'model'],
			label: 'Model',
			input: 'select',
			options: modelSelectOptions(),
		},
		{ type: 'field', path: [...base, 'prompt'], label: 'Prompt', input: 'textarea', placeholder: promptDefault },
	]
}

export interface ConfigFieldOption {
	value: string
	label: string
}

export interface ConfigEditField {
	path: string[]
	label: string
	input: ConfigFieldInput
	required?: boolean
	secret?: boolean
	placeholder?: string
	options?: ConfigFieldOption[]
}

export interface ConfigEditFieldControl extends ConfigEditField {
	type: 'field'
}

export interface ConfigEditListControl {
	type: 'list'
	path: string[]
	addLabel: string
	emptyLabel: string
	itemTitlePath: string[]
	defaultItem: Record<string, unknown>
	fields: ConfigEditField[]
}

export type ConfigEditControl = ConfigEditFieldControl | ConfigEditListControl

export interface ConfigEditSection {
	id: string
	title: string
	description?: string
	controls: ConfigEditControl[]
}

export interface ConfigEditMetadata {
	sections: ConfigEditSection[]
}

export interface DashboardSafeConfig {
	projects: Array<{
		slug: string
		repoPath: string
		baseBranch: string
		worktreeDir?: string
		color?: string
	}>
	polling: HelmConfig['polling']
	solver: HelmConfig['solver']
	spawner: HelmConfig['spawner']
	server: HelmConfig['server']
	github: HelmConfig['github']
	provider: Omit<HelmConfig['provider'], 'apiToken'>
	spawnerAdapters: SpawnerAdapterInfo[]
	/** Curated per-agent model options for model pickers (dashboard + extension). */
	modelCatalog: Record<'claude' | 'codex', ModelOption[]>
	taskBaseUrl?: string
}

export interface ConfigDocument {
	config: HelmConfig
	dashboard: DashboardSafeConfig
	edit: ConfigEditMetadata
	secretRedaction: typeof CONFIG_SECRET_REDACTION
}

const editMetadata: ConfigEditMetadata = validateEditMetadata({
	sections: [
		{
			id: 'provider',
			title: 'Provider',
			description: 'External task source configuration',
			controls: [
				{
					type: 'field',
					path: ['provider', 'type'],
					label: 'Type',
					input: 'select',
					required: true,
					options: [{ value: 'contember', label: 'Contember' }],
				},
				{
					type: 'field',
					path: ['provider', 'apiBaseUrl'],
					label: 'API Base URL',
					input: 'text',
					required: true,
					placeholder: 'https://...',
				},
				{
					type: 'field',
					path: ['provider', 'projectSlug'],
					label: 'Project Slug',
					input: 'text',
					required: true,
				},
				{
					type: 'field',
					path: ['provider', 'apiToken'],
					label: 'API Token',
					input: 'password',
					required: true,
					secret: true,
				},
				{
					type: 'field',
					path: ['provider', 'taskBaseUrl'],
					label: 'Task Base URL',
					input: 'text',
					placeholder: 'https://... (optional)',
				},
			],
		},
		{
			id: 'projects',
			title: 'Projects',
			description: 'Repositories that Helm monitors and solves tasks for',
			controls: [
				{
					type: 'list',
					path: ['projects'],
					addLabel: '+ Add project',
					emptyLabel: 'No projects configured.',
					itemTitlePath: ['slug'],
					defaultItem: { slug: '', repoPath: '', baseBranch: 'main' },
					fields: [
						{ path: ['slug'], label: 'Slug', input: 'text', required: true },
						{ path: ['repoPath'], label: 'Repo Path', input: 'text', required: true, placeholder: '/path/to/repo' },
						{ path: ['baseBranch'], label: 'Base Branch', input: 'text' },
						{ path: ['worktreeDir'], label: 'Worktree Dir', input: 'text', placeholder: '(optional)' },
						{ path: ['color'], label: 'Color', input: 'color' },
					],
				},
			],
		},
		{
			id: 'polling',
			title: 'Polling',
			description: 'How often Helm checks for new tasks',
			controls: [
				{
					type: 'field',
					path: ['polling', 'intervalSeconds'],
					label: 'Interval (seconds)',
					input: 'number',
					required: true,
				},
				{
					type: 'field',
					path: ['polling', 'since'],
					label: 'Since',
					input: 'text',
					placeholder: 'ISO date (optional)',
				},
			],
		},
		{
			id: 'solver',
			title: 'Solver',
			description: 'Agent invocation settings',
			controls: [
				{
					type: 'field',
					path: ['solver', 'type'],
					label: 'Type',
					input: 'select',
					options: [
						{ value: 'default', label: 'Default' },
						{ value: 'okena', label: 'Okena' },
					],
				},
				{
					type: 'field',
					path: ['solver', 'agent'],
					label: 'Agent',
					input: 'select',
					options: [
						{ value: 'claude', label: 'Claude Code' },
						{ value: 'codex', label: 'Codex' },
					],
				},
				{ type: 'field', path: ['solver', 'concurrency'], label: 'Concurrency', input: 'number' },
				{
					type: 'field',
					path: ['solver', 'model'],
					label: 'Model',
					input: 'select',
					options: [{ value: '', label: 'Agent default' }, ...modelSelectOptions()],
				},
				{
					type: 'field',
					path: ['solver', 'timeoutMinutes'],
					label: 'Idle timeout (min)',
					input: 'number',
					placeholder: 'Fail after this long with no agent activity',
				},
				{
					type: 'field',
					path: ['solver', 'maxBudgetUsd'],
					label: 'Max Budget ($)',
					input: 'number',
					placeholder: '(optional)',
				},
			],
		},
		{
			id: 'execution',
			title: 'Execution',
			description:
				'Where solve agents run. Worktree isolates each run in a fresh git worktree — safe for concurrent solves, never touches your checkout. Main checkout runs the agent directly in the project repo (Okena: a pane in the existing project window) — no worktree setup and your local env is reused, but the run shares your working tree, the agent must branch itself, and only one solve should run per repo.',
			controls: [
				{
					type: 'field',
					path: ['solver', 'workspace'],
					label: 'Workspace',
					input: 'select',
					options: [
						{ value: 'worktree', label: 'Worktree (isolated, default)' },
						{ value: 'main', label: 'Main checkout' },
					],
				},
			],
		},
		{
			id: 'ai-branch',
			title: 'AI · Branch naming',
			description: 'Cheap one-shot model that derives a conventional branch name (feat/…, fix/…)',
			controls: aiHelperControls(['solver', 'branchNaming'], DEFAULT_NAMING_INSTRUCTIONS),
		},
		{
			id: 'ai-display',
			title: 'AI · Display name',
			description: 'Compresses each source task title into a short dashboard label',
			controls: aiHelperControls(['solver', 'displayName'], DEFAULT_DISPLAY_INSTRUCTIONS),
		},
		{
			id: 'ai-model-guidance',
			title: 'AI · Model guidance',
			description:
				'Per-model "how to spend this model" block injected into the solve prompt (blank = built-in default)',
			controls: Object.values(MODEL_CATALOG)
				.flat()
				.map(m => ({
					type: 'field' as const,
					path: ['solver', 'modelGuidance', m.id],
					label: m.label,
					input: 'textarea' as const,
					placeholder: DEFAULT_MODEL_GUIDANCE[m.id] ?? '',
				})),
		},
		{
			id: 'ai-triage',
			title: 'AI · Intent triage',
			description: 'Pre-solve pass: restates the intent and assigns a verdict',
			controls: aiHelperControls(['solver', 'triage'], DEFAULT_ASSESSMENT_INSTRUCTIONS),
		},
		{
			id: 'spawner',
			title: 'Spawner',
			description: 'Default interactive planning surface',
			controls: [
				{
					type: 'field',
					path: ['spawner', 'name'],
					label: 'Default Spawner',
					input: 'select',
					options: listSpawnerAdapters().map(adapter => ({
						value: adapter.name,
						label: adapter.name,
					})),
				},
			],
		},
		{
			id: 'server',
			title: 'Server',
			description: 'Dashboard and API server',
			controls: [
				{ type: 'field', path: ['server', 'port'], label: 'Port', input: 'number' },
				{ type: 'field', path: ['server', 'host'], label: 'Host', input: 'text' },
			],
		},
		{
			id: 'github',
			title: 'GitHub',
			description: 'PR, comment, and deploy-tracking settings',
			controls: [
				{ type: 'field', path: ['github', 'createPrs'], label: 'Create PRs', input: 'boolean' },
				{ type: 'field', path: ['github', 'postComments'], label: 'Post Comments', input: 'boolean' },
				{ type: 'field', path: ['github', 'prPrefix'], label: 'PR Prefix', input: 'text' },
				{ type: 'field', path: ['github', 'trackDeployments'], label: 'Track Deployments', input: 'boolean' },
				{ type: 'field', path: ['github', 'deployPollSeconds'], label: 'Deploy Poll (seconds)', input: 'number' },
			],
		},
	],
})

type AiHelperConfig = HelmConfig['solver']['triage']

const HELPER_DEFAULT_PROMPTS = {
	branchNaming: DEFAULT_NAMING_INSTRUCTIONS,
	displayName: DEFAULT_DISPLAY_INSTRUCTIONS,
	triage: DEFAULT_ASSESSMENT_INSTRUCTIONS,
} as const

/**
 * Fill each AI helper's `model` + `prompt` with its resolved default so the Settings
 * view shows them as real, editable values (not placeholders/previews). The model
 * default follows the helper's effective provider (its `agent` override, else
 * `solver.agent`).
 */
function hydrateAiDefaults(config: HelmConfig): HelmConfig {
	const fill = (helper: AiHelperConfig, defaultPrompt: string): AiHelperConfig => ({
		...helper,
		model: helper.model ?? defaultHelperModel(helper.agent ?? config.solver.agent),
		prompt: helper.prompt ?? defaultPrompt,
	})
	const guidance = { ...config.solver.modelGuidance }
	for (const [id, text] of Object.entries(DEFAULT_MODEL_GUIDANCE)) {
		guidance[id] = guidance[id] || text
	}
	return {
		...config,
		solver: {
			...config.solver,
			branchNaming: fill(config.solver.branchNaming, HELPER_DEFAULT_PROMPTS.branchNaming),
			displayName: fill(config.solver.displayName, HELPER_DEFAULT_PROMPTS.displayName),
			triage: fill(config.solver.triage, HELPER_DEFAULT_PROMPTS.triage),
			modelGuidance: guidance,
		},
	}
}

/**
 * Inverse of {@link hydrateAiDefaults}: drop a helper's `model`/`prompt` when it still
 * equals the default, so saving persists only genuine overrides and the helpers keep
 * following the provider + picking up future default-prompt improvements.
 */
function stripAiHelperDefaults(config: HelmConfig): HelmConfig {
	const strip = (helper: AiHelperConfig, defaultPrompt: string): AiHelperConfig => ({
		...helper,
		model: helper.model === defaultHelperModel(helper.agent ?? config.solver.agent) ? undefined : helper.model,
		prompt: helper.prompt === defaultPrompt ? undefined : helper.prompt,
	})
	const guidance = Object.fromEntries(
		Object.entries(config.solver.modelGuidance).filter(([id, text]) => text && text !== DEFAULT_MODEL_GUIDANCE[id]),
	)
	return {
		...config,
		solver: {
			...config.solver,
			branchNaming: strip(config.solver.branchNaming, HELPER_DEFAULT_PROMPTS.branchNaming),
			displayName: strip(config.solver.displayName, HELPER_DEFAULT_PROMPTS.displayName),
			triage: strip(config.solver.triage, HELPER_DEFAULT_PROMPTS.triage),
			modelGuidance: guidance,
		},
	}
}

export function buildConfigDocument(raw: unknown, fallback: HelmConfig): ConfigDocument {
	const config = parseConfigWithFallback(raw, fallback)
	const hydrated = hydrateAiDefaults(config)
	return {
		config: redactEditableConfig(hydrated),
		dashboard: toDashboardSafeConfig(config),
		edit: withCurrentSelectValues(editMetadata, hydrated),
		secretRedaction: CONFIG_SECRET_REDACTION,
	}
}

/**
 * A select whose current config value isn't among its options would render
 * blank and silently rewrite the value on save. Surface such a value (a
 * hand-edited model id, a catalog entry removed later) as an extra
 * "(custom)" option instead of losing it.
 */
function withCurrentSelectValues(edit: ConfigEditMetadata, config: HelmConfig): ConfigEditMetadata {
	const valueAt = (path: string[]): unknown =>
		path.reduce<unknown>(
			(node, key) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined),
			config,
		)
	return {
		sections: edit.sections.map(section => ({
			...section,
			controls: section.controls.map(control => {
				if (control.type !== 'field' || control.input !== 'select' || !control.options) return control
				const value = valueAt(control.path)
				if (typeof value !== 'string' || value === '') return control
				if (control.options.some(option => option.value === value)) return control
				return { ...control, options: [...control.options, { value, label: `${value} (custom)` }] }
			}),
		})),
	}
}

export function toDashboardSafeConfig(config: HelmConfig): DashboardSafeConfig {
	const { apiToken: _apiToken, ...provider } = config.provider
	return {
		projects: config.projects.map(project => ({
			slug: project.slug,
			repoPath: project.repoPath,
			baseBranch: project.baseBranch,
			worktreeDir: project.worktreeDir,
			color: project.color,
		})),
		polling: config.polling,
		solver: config.solver,
		spawner: config.spawner,
		server: config.server,
		github: config.github,
		provider,
		spawnerAdapters: listSpawnerAdapters(),
		modelCatalog: MODEL_CATALOG,
		taskBaseUrl: provider.taskBaseUrl,
	}
}

export function parseConfigUpdate(body: unknown, currentConfig: HelmConfig) {
	const next = preserveRedactedSecrets(body, currentConfig)
	const unknownPaths = findUnknownConfigPaths(configSchema, next)
	if (unknownPaths.length > 0) {
		return {
			success: false,
			error: new z.ZodError(
				unknownPaths.map(path => ({
					code: z.ZodIssueCode.custom,
					path: [],
					message: `Unknown config field: ${path}`,
				})),
			),
		} as const
	}
	const parsed = configSchema.safeParse(next)
	// Only persist AI-helper overrides that genuinely differ from the default, so the
	// hydrated defaults shown in Settings don't bloat the config file or freeze it.
	if (parsed.success) return { success: true as const, data: stripAiHelperDefaults(parsed.data) }
	return parsed
}

export function parseConfigWithFallback(raw: unknown, fallback: HelmConfig): HelmConfig {
	const parsed = configSchema.safeParse(raw)
	return parsed.success ? parsed.data : fallback
}

/**
 * Accepts segment arrays (exact) or dot-joined strings (legacy convenience —
 * ambiguous for record keys containing dots, e.g. model ids like `gpt-5.5`;
 * pass an array when a segment may contain a dot).
 */
export function configSchemaAcceptsPath(path: string | string[]): boolean {
	return schemaAcceptsPath(configSchema, Array.isArray(path) ? path : path.split('.'))
}

/** Config-file keys the schema doesn't recognize (and silently strips on load). */
export function unknownConfigPaths(raw: unknown): string[] {
	return findUnknownConfigPaths(configSchema, raw)
}

function redactEditableConfig(config: HelmConfig): HelmConfig {
	return {
		...config,
		provider: {
			...config.provider,
			apiToken: CONFIG_SECRET_REDACTION,
		},
	}
}

function preserveRedactedSecrets(body: unknown, currentConfig: HelmConfig): unknown {
	if (!isRecord(body)) return body
	const next = structuredClone(body)
	const provider = next.provider
	if (isRecord(provider) && provider.apiToken === CONFIG_SECRET_REDACTION) {
		provider.apiToken = currentConfig.provider.apiToken
	}
	return next
}

function validateEditMetadata(metadata: ConfigEditMetadata): ConfigEditMetadata {
	for (const section of metadata.sections) {
		for (const control of section.controls) {
			if (control.type === 'field') {
				assertConfigPath(control.path)
				continue
			}
			assertConfigPath(control.path)
			for (const field of control.fields) {
				assertConfigPath([...control.path, '*', ...field.path])
			}
		}
	}
	return metadata
}

function assertConfigPath(path: string[]): void {
	// Validate on the SEGMENT ARRAY — joining and re-splitting on '.' would
	// mangle record keys that contain dots (model ids like `gpt-5.5`).
	if (!schemaAcceptsPath(configSchema, path)) {
		throw new Error(`Config edit field is not accepted by config schema: ${path.join('.')}`)
	}
}

function schemaAcceptsPath(schema: z.ZodTypeAny, path: string[]): boolean {
	let current = unwrapSchema(schema)
	for (const part of path) {
		current = unwrapSchema(current)
		if (current instanceof z.ZodArray) {
			if (part !== '*') return false
			current = current.element
			continue
		}
		if (current instanceof z.ZodObject) {
			const shape = current.shape
			const next = shape[part]
			if (!next) return false
			current = next
			continue
		}
		if (current instanceof z.ZodRecord) {
			// Any key is valid for a record; descend into the value schema.
			current = current.valueSchema
			continue
		}
		return false
	}
	return true
}

function findUnknownConfigPaths(schema: z.ZodTypeAny, value: unknown, path: string[] = []): string[] {
	const current = unwrapSchema(schema)
	if (current instanceof z.ZodArray) {
		if (!Array.isArray(value)) return []
		return value.flatMap((item, index) => findUnknownConfigPaths(current.element, item, [...path, String(index)]))
	}
	if (current instanceof z.ZodObject) {
		if (!isRecord(value)) return []
		const shape = current.shape
		return Object.entries(value).flatMap(([key, nested]) => {
			const child = shape[key]
			if (!child) return [formatConfigPath([...path, key])]
			return findUnknownConfigPaths(child, nested, [...path, key])
		})
	}
	return []
}

function formatConfigPath(path: string[]): string {
	return path.length > 0 ? path.join('.') : '<root>'
}

function unwrapSchema(schema: z.ZodTypeAny): z.ZodTypeAny {
	let current = schema
	while (current instanceof z.ZodDefault || current instanceof z.ZodOptional || current instanceof z.ZodNullable) {
		current = current._def.innerType
	}
	return current
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}
