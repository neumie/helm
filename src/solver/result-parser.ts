import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { SolverResult } from '../types.js'
import { log } from '../util/logger.js'

const solverResultSchema = z.object({
	tier: z.enum(['trivial', 'simple', 'complex', 'unclear']),
	confidence: z.number().min(0).max(1),
	summary: z.string(),
	filesChanged: z.array(z.string()).default([]),
	analysis: z.string().optional(),
	questionsForRequester: z.array(z.string()).optional(),
	remainingWork: z.array(z.string()).optional(),
	prReady: z.boolean(),
	prTitle: z.string().optional(),
	prBody: z.string().optional(),
})

export function parseResultFile(worktreePath: string, externalId: string): SolverResult | null {
	const resultPath = join(worktreePath, 'docs', 'plans', externalId, 'solver-result.json')
	try {
		const raw = readFileSync(resultPath, 'utf-8')
		const json = JSON.parse(raw)
		return solverResultSchema.parse(json)
	} catch (err) {
		log.warn('result-parser', `Could not read ${resultPath}`, err)
		return null
	}
}

/**
 * Fallback: attempt to extract tier from Claude's stdout JSON output.
 */
export function parseTierFromOutput(stdout: string): SolverResult | null {
	try {
		// Claude --output-format json returns an array of messages
		const messages = JSON.parse(stdout)
		if (!Array.isArray(messages)) return null

		// Look through assistant messages for tier mentions
		for (const msg of messages) {
			if (msg.type !== 'assistant' || !msg.content) continue
			for (const block of msg.content) {
				if (block.type !== 'text') continue
				const text: string = block.text

				// Try to find a JSON block with tier info
				const jsonMatch = text.match(/\{[^{}]*"tier"\s*:\s*"(trivial|simple|complex|unclear)"[^{}]*\}/)
				if (jsonMatch) {
					try {
						const parsed = JSON.parse(jsonMatch[0])
						return solverResultSchema.parse({
							tier: parsed.tier,
							confidence: parsed.confidence ?? 0.5,
							summary: parsed.summary ?? 'Extracted from output',
							filesChanged: parsed.filesChanged ?? [],
							prReady: parsed.prReady ?? false,
							...parsed,
						})
					} catch {
						// continue searching
					}
				}

				// Simple keyword match
				for (const tier of ['trivial', 'simple', 'complex', 'unclear'] as const) {
					if (text.toLowerCase().includes(`tier: ${tier}`) || text.toLowerCase().includes(`"tier": "${tier}"`)) {
						return {
							tier,
							confidence: 0.3,
							summary: 'Extracted from output (fallback)',
							filesChanged: [],
							prReady: false,
						}
					}
				}
			}
		}
	} catch {
		// Not valid JSON output
	}
	return null
}
