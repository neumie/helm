import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'

const contemberProviderSchema = z.object({
	type: z.literal('contember'),
	apiBaseUrl: z.string().url(),
	projectSlug: z.string(),
	apiToken: z.string().min(1),
	taskBaseUrl: z.string().optional(),
	statuses: z.array(z.string()).default(['new']),
})

// Future providers go here as union members
const providerSchema = z.discriminatedUnion('type', [contemberProviderSchema])

const projectSchema = z.object({
	slug: z.string(),
	repoPath: z.string(),
	baseBranch: z.string().default('main'),
	worktreeDir: z.string().optional(),
	color: z.string().optional(),
})

export const configSchema = z.object({
	provider: providerSchema,
	projects: z.array(projectSchema).min(1),
	polling: z
		.object({
			intervalSeconds: z.number().min(5).default(60),
			since: z.string().optional(),
		})
		.default({}),
	solver: z
		.object({
			type: z.enum(['default', 'okena']).default('default'),
			concurrency: z.number().min(1).max(10).default(2),
			model: z.string().optional(),
			maxBudgetUsd: z.number().optional(),
			timeoutMinutes: z.number().min(1).default(30),
		})
		.default({}),
	server: z
		.object({
			port: z.number().default(7474),
			host: z.string().default('localhost'),
		})
		.default({}),
	github: z
		.object({
			createPrs: z.boolean().default(true),
			postComments: z.boolean().default(true),
			prPrefix: z.string().default('[Vigil]'),
		})
		.default({}),
	chat: z
		.object({
			enabled: z.boolean().default(false),
			secret: z.string().min(16),
			expiryDays: z.number().min(1).default(7),
			baseUrl: z.string().url().optional(),
			tunnel: z.boolean().default(false),
			timeoutMinutes: z.number().min(1).default(120),
			webhook: z
				.object({
					url: z.string().url(),
					headers: z.record(z.string()).optional(),
				})
				.optional(),
		})
		.optional(),
})

export type VigilConfig = z.infer<typeof configSchema>
export type ProjectConfig = z.infer<typeof projectSchema>

export function loadConfig(configPath?: string): { config: VigilConfig; configPath: string } {
	const path = configPath ?? process.env.VIGIL_CONFIG ?? resolve(process.cwd(), 'vigil.config.json')
	const raw = readFileSync(path, 'utf-8')
	const json = JSON.parse(raw)
	return { config: configSchema.parse(json), configPath: path }
}
