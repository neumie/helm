import { z } from 'zod'

export const solverAgentSchema = z.enum(['claude', 'codex', 'pi'])

export type SolverAgent = z.infer<typeof solverAgentSchema>

export function solverAgentLabel(agent: SolverAgent): string {
	switch (agent) {
		case 'claude':
			return 'Claude Code'
		case 'codex':
			return 'Codex'
		case 'pi':
			return 'Pi'
	}
}
