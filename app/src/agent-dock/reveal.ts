// Agent dock "show terminal" (design §3.24): from an item's pane or an agent's detail, bring up the
// terminal the agent runs in. Pure target building is shared with the renderer (which shows the
// affordance and reveals Helm terminals itself: tab activation + an accent pulse on the frame);
// Okena panes go through main (agent-dock:reveal), which re-reads Okena's layout, posts
// `focus_terminal` (Okena reveals the pane: switches tabs, retargets zoom/fullscreen, orders its
// window front) and then raises the Okena app, which Okena's own focus never does.
//
// Focus only: nothing is ever written to the terminal (a BEL or any byte would reach the agent).

import { errorDetail } from './act'
import { type AgentDockRevealResult, type DockSession, okenaLayoutProject, parseOkenaState } from './model'

/** Where an agent's terminal is shown from the dock. */
export type DockRevealTarget =
	/** An Okena pane: main focuses it through Okena's API and raises the app. */
	| { kind: 'okena'; session: string; profile: string; terminalId: string; projectId: string }
	/** A Helm terminal (Helm's own hub): the window switches to its tab and pulses its frame. */
	| { kind: 'helm'; session: string; terminalId: string }

/**
 * The dock's reveal target for a session, or null when there is nothing to show: no session, no
 * terminal id, or an Okena pane that is in no project's layout (a hook/service terminal: Okena cannot
 * focus it).
 */
export function dockRevealTarget(
	session: Pick<DockSession, 'key' | 'source' | 'profile' | 'terminalId' | 'projectId'> | undefined,
): DockRevealTarget | null {
	if (!session?.terminalId) return null
	if (session.source === 'helm') return { kind: 'helm', session: session.key, terminalId: session.terminalId }
	if (!session.projectId) return null
	return {
		kind: 'okena',
		session: session.key,
		profile: session.profile,
		terminalId: session.terminalId,
		projectId: session.projectId,
	}
}

/** The affordance's words: where the terminal will show. */
export const revealLabel = (target: DockRevealTarget): string =>
	target.kind === 'okena' ? 'Show in Okena' : 'Show terminal'

/** Okena's `POST /v1/actions` body (`ActionRequest::FocusTerminal`, as `okena term focus`; no window: Okena picks the one showing the project). */
export const okenaFocusAction = (projectId: string, terminalId: string) =>
	({ action: 'focus_terminal', project_id: projectId, terminal_id: terminalId }) as const

export const REVEAL_TEXT = {
	invalid: 'invalid agent',
	helm: 'A Helm terminal is shown by its window.',
	unreachable: 'Okena is unreachable',
	gone: "The agent's terminal is no longer open in Okena.",
	notFocused: 'Okena did not focus the terminal',
} as const

/** `<okena profile>:<terminal id>` (profile ids may hold `:`; terminal ids never do), or null. */
export function parseRevealSession(key: unknown): { profile: string; terminalId: string } | null {
	if (typeof key !== 'string' || key.length === 0 || key.length > 512) return null
	const at = key.lastIndexOf(':')
	if (at <= 0 || at === key.length - 1) return null
	return { profile: key.slice(0, at), terminalId: key.slice(at + 1) }
}

/**
 * The footer's words for a refused `focus_terminal`. Okena answers a refusal `400 {"error":"…"}`
 * (OkenaClient: `Okena action failed (400): {"error":"terminal not found: <id>"}`): a terminal closed
 * between the layout read and the POST reads as gone; any other reason is shown bare, not as JSON.
 */
export function focusRefusal(error: unknown): string {
	const detail = errorDetail(error)
	const body = /^Okena action failed \(\d+\): (\{.*\})$/.exec(detail)?.[1]
	let reason = detail
	if (body) {
		try {
			const parsed: unknown = JSON.parse(body)
			const said = (parsed as { error?: unknown } | null)?.error
			if (typeof said === 'string' && said.trim()) reason = said.trim()
		} catch {
			// Not JSON after all: keep the whole line.
		}
	}
	if (/\b(terminal|project) not found\b/i.test(reason)) return REVEAL_TEXT.gone
	return `${REVEAL_TEXT.notFocused}: ${reason}`
}

/** The OkenaClient surface a reveal uses (structural, so tests inject a double). */
export interface OkenaRevealClient {
	forProfile(profileId: string): OkenaRevealClient
	getStateJson(opts?: { timeoutMs?: number; maxBytes?: number }): Promise<unknown>
	action(payload: Record<string, unknown>, opts?: { signal?: AbortSignal }): Promise<unknown>
}

export interface OkenaRevealDeps {
	client: OkenaRevealClient
	/** Raise the Okena app (activateOkenaApp); false when it could not. */
	activate(): Promise<boolean>
}

const REVEAL_READ_TIMEOUT_MS = 3_000
const REVEAL_STATE_MAX_BYTES = 4 * 1024 * 1024
const REVEAL_FOCUS_TIMEOUT_MS = 5_000

/**
 * Main's half of "Show in Okena" for a session key from the renderer (untrusted): a fresh
 * `GET /v1/state` finds the project whose layout shows the terminal now, then `focus_terminal`, then
 * the app is raised. Never throws; the detail is a quiet line for the pane's footer.
 */
export async function revealOkenaTerminal(sessionKey: unknown, deps: OkenaRevealDeps): Promise<AgentDockRevealResult> {
	const pane = parseRevealSession(sessionKey)
	if (!pane) return { ok: false, detail: REVEAL_TEXT.invalid }
	// Helm's hub profiles (claude-hub-wire `helmDockProfile`; not imported here: that module pulls
	// node:net into the renderer, which shares this file).
	if (pane.profile.startsWith('helm:')) return { ok: false, detail: REVEAL_TEXT.helm }
	const client = deps.client.forProfile(pane.profile)
	let projectId: string
	try {
		const state = parseOkenaState(
			await client.getStateJson({ timeoutMs: REVEAL_READ_TIMEOUT_MS, maxBytes: REVEAL_STATE_MAX_BYTES }),
		)
		if (!state.ok) return { ok: false, detail: `${REVEAL_TEXT.unreachable}: ${state.error}` }
		const project = okenaLayoutProject(state.value, pane.terminalId)
		if (!project) return { ok: false, detail: REVEAL_TEXT.gone }
		projectId = project.id
	} catch (error) {
		return { ok: false, detail: `${REVEAL_TEXT.unreachable}: ${errorDetail(error)}` }
	}
	try {
		await client.action(okenaFocusAction(projectId, pane.terminalId), {
			signal: AbortSignal.timeout(REVEAL_FOCUS_TIMEOUT_MS),
		})
	} catch (error) {
		return { ok: false, detail: focusRefusal(error) }
	}
	return { ok: true, activated: await deps.activate().catch(() => false) }
}
