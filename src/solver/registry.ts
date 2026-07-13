import type { HelmConfig } from '../config.js'
import { DefaultSolver } from './default-solver.js'
import type { Solver } from './solver.js'

/**
 * The single construction site for the active {@link Solver}, mirroring
 * `providers/registry.ts` for the provider seam.
 *
 * **No fallback.** The configured `solver.type` is the active type, full stop —
 * if the operator configured `okena`, we use okena or fail loudly, never silently
 * swap in `DefaultSolver`. Okena is constructed even when momentarily unreachable
 * (the factory only warns), so okena errors surface per task (logs + dashboard)
 * and recover on their own once okena is back — `OkenaClient` reloads its token
 * per call, so no daemon restart is needed. This replaced an earlier silent
 * fallback that masked okena outages and latched the daemon onto DefaultSolver
 * until a manual restart.
 *
 * Optional/extension solvers still load via dynamic `import()` (never a static
 * top-level import) so an unavailable optional dependency can't crash module load.
 *
 * To add a backend: extend the `solver.type` enum in `config.ts`, then add a
 * branch here that dynamically imports its `createX(config)` factory.
 */
export async function createSolver(config: HelmConfig): Promise<Solver> {
	if (config.solver.type === 'okena') {
		const { createOkenaSolver } = await import('../extensions/okena/solver.js')
		return createOkenaSolver(config)
	}

	return new DefaultSolver()
}
