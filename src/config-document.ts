import { z } from 'zod'
import { configSchema } from './config.js'
import type { VigilConfig } from './config.js'
import { listSpawnerAdapters } from './spawner/registry.js'
import type { SpawnerAdapterInfo } from './spawner/registry.js'

export const CONFIG_SECRET_REDACTION = '********'

export type ConfigFieldInput = 'text' | 'password' | 'number' | 'boolean' | 'select' | 'color'

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
	polling: VigilConfig['polling']
	solver: VigilConfig['solver']
	spawner: VigilConfig['spawner']
	server: VigilConfig['server']
	github: VigilConfig['github']
	provider: Omit<VigilConfig['provider'], 'apiToken'>
	spawnerAdapters: SpawnerAdapterInfo[]
	taskBaseUrl?: string
}

export interface ConfigDocument {
	config: VigilConfig
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
			description: 'Repositories that Vigil monitors and solves tasks for',
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
			description: 'How often Vigil checks for new tasks',
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
					input: 'text',
					placeholder: 'Agent model override (optional)',
				},
				{
					type: 'field',
					path: ['solver', 'nameModel', 'enabled'],
					label: 'AI Branch Naming',
					input: 'boolean',
				},
				{
					type: 'field',
					path: ['solver', 'nameModel', 'model'],
					label: 'Naming Model',
					input: 'text',
					placeholder: 'claude-haiku-4-5 / gpt-5-mini (optional)',
				},
				{ type: 'field', path: ['solver', 'timeoutMinutes'], label: 'Timeout (min)', input: 'number' },
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
			description: 'PR and comment settings',
			controls: [
				{ type: 'field', path: ['github', 'createPrs'], label: 'Create PRs', input: 'boolean' },
				{ type: 'field', path: ['github', 'postComments'], label: 'Post Comments', input: 'boolean' },
				{ type: 'field', path: ['github', 'prPrefix'], label: 'PR Prefix', input: 'text' },
			],
		},
	],
})

export function buildConfigDocument(raw: unknown, fallback: VigilConfig): ConfigDocument {
	const config = parseConfigWithFallback(raw, fallback)
	return {
		config: redactEditableConfig(config),
		dashboard: toDashboardSafeConfig(config),
		edit: editMetadata,
		secretRedaction: CONFIG_SECRET_REDACTION,
	}
}

export function toDashboardSafeConfig(config: VigilConfig): DashboardSafeConfig {
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
		taskBaseUrl: provider.taskBaseUrl,
	}
}

export function parseConfigUpdate(body: unknown, currentConfig: VigilConfig) {
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
	return configSchema.safeParse(next)
}

export function parseConfigWithFallback(raw: unknown, fallback: VigilConfig): VigilConfig {
	const parsed = configSchema.safeParse(raw)
	return parsed.success ? parsed.data : fallback
}

export function configSchemaAcceptsPath(path: string): boolean {
	return schemaAcceptsPath(configSchema, path.split('.'))
}

function redactEditableConfig(config: VigilConfig): VigilConfig {
	return {
		...config,
		provider: {
			...config.provider,
			apiToken: CONFIG_SECRET_REDACTION,
		},
	}
}

function preserveRedactedSecrets(body: unknown, currentConfig: VigilConfig): unknown {
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
	const key = path.join('.')
	if (!configSchemaAcceptsPath(key)) throw new Error(`Config edit field is not accepted by config schema: ${key}`)
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
