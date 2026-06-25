import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'
import { solverAgentSchema } from './solver/agent.js'
import { spawnerNameSchema } from './spawner/name.js'

const contemberProviderSchema = z.object({
	type: z.literal('contember'),
	apiBaseUrl: z.string().url(),
	projectSlug: z.string(),
	apiToken: z.string().min(1),
	taskBaseUrl: z.string().optional(),
	statuses: z.array(z.string()).default(['new']),
})

// Only one provider exists. If a second is added, make this a
// z.discriminatedUnion('type', [...]) again and branch in providers/registry.ts.
const providerSchema = contemberProviderSchema

const projectSchema = z.object({
	slug: z.string(),
	repoPath: z.string(),
	baseBranch: z.string().default('main'),
	worktreeDir: z.string().optional(),
	color: z.string().optional(),
})

const spawnerSchema = z
	.object({
		name: spawnerNameSchema.default('default'),
	})
	.default({ name: 'default' })

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
			agent: solverAgentSchema.default('claude'),
			concurrency: z.number().min(1).max(10).default(2),
			model: z.string().optional(),
			maxBudgetUsd: z.number().optional(),
			timeoutMinutes: z.number().min(1).default(30),
			// Opt-in: derive a conventional branch name (feat/…, fix/…) from task
			// context via a cheap one-shot model call. `model` overrides the per-agent
			// default (claude → claude-haiku-4-5, codex → gpt-5-mini). Any failure
			// degrades to the deterministic vigil/item/<slug> default.
			nameModel: z
				.object({
					enabled: z.boolean().default(false),
					model: z.string().optional(),
				})
				.default({}),
		})
		.default({}),
	spawner: spawnerSchema,
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
})

export type VigilConfig = z.infer<typeof configSchema>
export type ProjectConfig = z.infer<typeof projectSchema>

export function loadConfig(configPath?: string): { config: VigilConfig; configPath: string } {
	const path = configPath ?? process.env.VIGIL_CONFIG ?? resolve(process.cwd(), 'vigil.config.json')
	const raw = readFileSync(path, 'utf-8')
	const json = JSON.parse(raw)
	return { config: configSchema.parse(json), configPath: path }
}
