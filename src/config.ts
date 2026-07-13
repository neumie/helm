import { existsSync, readFileSync } from 'node:fs'
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

// A cheap one-shot AI helper (branch naming, display naming, intent triage). Each
// is independently toggleable and can override the provider (`agent`), `model`,
// and instruction `prompt` (blank → the built-in default; the task data is always
// injected by code, so a custom prompt only replaces the instructions).
const aiHelperSchema = (defaultEnabled: boolean) =>
	z
		.object({
			enabled: z.boolean().default(defaultEnabled),
			agent: solverAgentSchema.optional(),
			model: z.string().optional(),
			prompt: z.string().optional(),
		})
		.default({})

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
			// Okena solver: IDLE timeout — fail only after this long with no
			// terminal-screen activity (long ACTIVE runs are legitimate; a 6h hard cap
			// in the okena solver backstops). Default solver: wall-clock cap on the
			// spawned agent CLI (src/solver/invoker.ts).
			timeoutMinutes: z.number().min(1).default(30),
			// AI helpers (cheap one-shot model calls), each independently configurable
			// in Settings (on/off, provider, model, prompt). Defaults: model per-agent
			// (claude → claude-haiku-4-5, codex → gpt-5.4-mini), provider = `solver.agent`.
			// Branch naming: derive a conventional branch (feat/…, fix/…); failure →
			// deterministic helm/item/<slug>. Opt-in (default off).
			branchNaming: aiHelperSchema(false),
			// Display name: compress each source title into a short dashboard label;
			// failure → the raw title. Default on.
			displayName: aiHelperSchema(true),
			// Intent triage: restate intent + a verdict (clear /
			// needs_clarification / human_decision / not_code / security) so the human
			// checkpoint is "approve the intent" not "test the PR". Advisory; never
			// changes status. Default on.
			triage: aiHelperSchema(true),
			// Per-model "how to spend this model" prompt overrides, keyed by model id.
			// Blank/missing → the built-in default in src/solver/models.ts.
			modelGuidance: z.record(z.string()).default({}),
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
			prPrefix: z.string().default('[Helm]'),
			// DeployWatcher: observe PR merge + GitHub Deployments per environment for
			// shipped Items and surface the deploy ladder. Read-only GitHub polling.
			trackDeployments: z.boolean().default(true),
			deployPollSeconds: z.number().min(15).default(120),
		})
		.default({}),
})

export type HelmConfig = z.infer<typeof configSchema>
export type ProjectConfig = z.infer<typeof projectSchema>

/**
 * Resolve the config file path: explicit arg, then $HELM_CONFIG (preferred),
 * then $VIGIL_CONFIG (legacy compat), then ./helm.config.json, falling back to
 * ./vigil.config.json (legacy name) with a startup warning asking for a rename.
 * Exported for tests.
 */
export function resolveConfigPath(configPath?: string): string {
	if (configPath) return configPath
	if (process.env.HELM_CONFIG) return process.env.HELM_CONFIG
	if (process.env.VIGIL_CONFIG) return process.env.VIGIL_CONFIG
	const helmPath = resolve(process.cwd(), 'helm.config.json')
	if (existsSync(helmPath)) return helmPath
	const legacyPath = resolve(process.cwd(), 'vigil.config.json')
	if (existsSync(legacyPath)) {
		console.warn(`[helm] Using legacy config file ${legacyPath} — rename it to helm.config.json.`)
		return legacyPath
	}
	return helmPath
}

export function loadConfig(configPath?: string): { config: HelmConfig; configPath: string; raw: unknown } {
	const path = resolveConfigPath(configPath)
	const raw = readFileSync(path, 'utf-8')
	const json = JSON.parse(raw)
	return { config: configSchema.parse(json), configPath: path, raw: json }
}
