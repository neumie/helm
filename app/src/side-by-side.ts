// Opt-in side-by-side dev instance (`HELM_SIDE_BY_SIDE=1` + `--user-data-dir=`).
//
// A second interactive Helm from a worktree must never compete with the
// operator's running Helm for its singleton/owner effects: OS protocol
// handlers, the daemon scheduled-run lease, scheduled attention adoption and
// notifications, the shared document-review control host, daemon writes
// (task watch, protocol-mismatch restart, profile activation, Item commands),
// Remote pairing writes, or the live dtach socket namespace. It keeps
// terminals (own namespace), the read-only task sidebar and the agent dock.
//
// Pure (no Electron import) so the gating is unit-testable; main.ts applies it
// before anything touches userData or the socket namespace.

import { realpathSync } from 'node:fs'
import * as path from 'node:path'

export const SIDE_BY_SIDE_ENV = 'HELM_SIDE_BY_SIDE'
export const SIDE_BY_SIDE_TITLE = 'Helm (dock dev)'
export const SIDE_BY_SIDE_READ_ONLY_ERROR = 'Disabled in the side-by-side dev instance (read-only daemon access).'

export interface SideBySideLaunch {
	/** Absolute dedicated profile directory (never the operator's Helm profile). */
	userDataDir: string
	/** Absolute isolated dtach socket root (never the live `/tmp/helm-<uid>`). */
	socketRoot: string
}

export interface SideBySideLaunchInput {
	argv: readonly string[]
	env: Readonly<Record<string, string | undefined>>
	/** Electron `app.getPath('appData')`. */
	appDataDir: string
	appName: string
	uid: number
	screenshot: boolean
	attestation: boolean
	/** `os.homedir()`; enables the `~/.helm` operator-root refusal. */
	homeDir?: string
	/** Symlink resolver for an EXISTING path (tests inject one). Default: `fs.realpathSync.native`. */
	realpath?: (existing: string) => string
}

function argumentValue(argv: readonly string[], prefix: string): string | null {
	const match = argv.find(argument => argument.startsWith(prefix))
	return match === undefined ? null : match.slice(prefix.length)
}

type Realpath = (existing: string) => string

/** Resolve symlinks through the nearest existing ancestor (the rest of the path may not exist yet). */
function canonical(p: string, realpath: Realpath): string {
	const resolved = path.resolve(p)
	const tail: string[] = []
	let head = resolved
	for (;;) {
		try {
			return path.join(realpath(head), ...tail)
		} catch {
			const parent = path.dirname(head)
			if (parent === head) return resolved
			tail.unshift(path.basename(head))
			head = parent
		}
	}
}

/** `/private/tmp` and `/tmp` (and `/private/var` ↔ `/var`) name the same macOS directory; APFS is case-insensitive. */
function comparable(p: string, realpath: Realpath): string {
	const resolved = canonical(p, realpath)
	const unprivate = resolved.startsWith('/private/') ? resolved.slice('/private'.length) : resolved
	return unprivate.replace(/\/+$/, '').toLowerCase()
}

function sameOrInside(candidate: string, root: string, realpath: Realpath): boolean {
	const a = comparable(candidate, realpath)
	const b = comparable(root, realpath)
	return a === b || a.startsWith(`${b}/`)
}

/** Either path contains the other (or they are the same directory). */
function overlaps(a: string, b: string, realpath: Realpath): boolean {
	return sameOrInside(a, b, realpath) || sameOrInside(b, a, realpath)
}

const defaultRealpath: Realpath = existing => realpathSync.native(existing)

/** The operator's live terminal namespace root (mirrors `sessions.socketNamespaceRoot()` without an override). */
export function liveSocketRoot(uid: number): string {
	return `/tmp/helm-${uid}`
}

/** The live scheduled-run namespace root (mirrors `scheduledSocketRoot()` in src/scheduled-runs/session-path.ts). */
export function liveScheduledSocketRoot(env: Readonly<Record<string, string | undefined>>, uid: number): string {
	return path.resolve(env.HELM_SCHEDULED_SOCKET_DIR ?? `/tmp/helm-sched-${uid}`)
}

export function defaultSideBySideSocketRoot(uid: number): string {
	return `/tmp/helm-dockdev-${uid}`
}

/**
 * True whenever the mode is requested at all (valid or not). Used where a
 * decision must be made before full validation: invalid requests exit at
 * startup, so treating them as side-by-side earlier is the safe direction.
 */
export function sideBySideRequested(env: Readonly<Record<string, string | undefined>>): boolean {
	const flag = env[SIDE_BY_SIDE_ENV]
	return flag !== undefined && flag !== '' && flag !== '0'
}

/**
 * Parse and fail-closed validate the side-by-side launch. Returns null when the
 * mode is not requested; throws when it is requested but unsafe/ambiguous.
 */
export function parseSideBySideLaunch(input: SideBySideLaunchInput): SideBySideLaunch | null {
	const flag = input.env[SIDE_BY_SIDE_ENV]
	if (flag === undefined || flag === '' || flag === '0') return null
	if (flag !== '1') throw new Error(`${SIDE_BY_SIDE_ENV} must be 1 or 0 (got ${JSON.stringify(flag)})`)
	if (input.screenshot) throw new Error(`${SIDE_BY_SIDE_ENV}=1 cannot be combined with --screenshot`)
	if (input.attestation) throw new Error(`${SIDE_BY_SIDE_ENV}=1 cannot be combined with profile-switch attestation`)
	if (input.argv.includes('--user-data-dir-tmp')) {
		throw new Error(`${SIDE_BY_SIDE_ENV}=1 requires a stable --user-data-dir=<path>, not --user-data-dir-tmp`)
	}
	const rawUserData = argumentValue(input.argv, '--user-data-dir=')
	if (!rawUserData) throw new Error(`${SIDE_BY_SIDE_ENV}=1 requires --user-data-dir=<dedicated path>`)
	const userDataDir = path.resolve(rawUserData)
	const realpath = input.realpath ?? defaultRealpath
	// The operator's profile (packaged and unpackaged both resolve to appData/Helm),
	// Chromium's unbranded default, Okena's config and the daemon home (~/.helm:
	// local API token, Remote, document review) must never be shared with, or
	// nested in, the dev instance's profile. Compared through symlinks.
	const forbiddenRoots = [
		...[input.appName, 'Helm', 'Electron', 'okena'].map(name => path.join(input.appDataDir, name)),
		...(input.homeDir ? [path.join(input.homeDir, '.helm')] : []),
	]
	for (const forbiddenDir of forbiddenRoots) {
		if (overlaps(userDataDir, forbiddenDir, realpath)) {
			throw new Error(
				`${SIDE_BY_SIDE_ENV}=1 refuses the shared profile ${forbiddenDir}; pass a dedicated --user-data-dir`,
			)
		}
	}
	if (sameOrInside(input.appDataDir, userDataDir, realpath)) {
		throw new Error(`${SIDE_BY_SIDE_ENV}=1 refuses a --user-data-dir that contains ${input.appDataDir}`)
	}

	const rawSocket = input.env.HELM_SOCKET_DIR
	const socketRoot = rawSocket ? path.resolve(rawSocket) : defaultSideBySideSocketRoot(input.uid)
	const live = liveSocketRoot(input.uid)
	if (overlaps(socketRoot, live, realpath)) {
		throw new Error(`${SIDE_BY_SIDE_ENV}=1 refuses the live terminal socket namespace ${live}`)
	}
	const scheduled = liveScheduledSocketRoot(input.env, input.uid)
	if (overlaps(socketRoot, scheduled, realpath)) {
		throw new Error(`${SIDE_BY_SIDE_ENV}=1 refuses the live scheduled-run socket namespace ${scheduled}`)
	}
	return { userDataDir, socketRoot }
}

export interface StartupPolicyInput {
	screenshot: boolean
	attestation: boolean
	sideBySide: boolean
	/** `--user-data-dir=` given. */
	customUserData: boolean
	/** `--user-data-dir-tmp` given. */
	tmpUserData: boolean
	/** Raw `HELM_AGENT_DOCK` env value. */
	agentDockEnv: string | undefined
}

/** Which singleton/owner effects this launch may perform. */
export interface StartupPolicy {
	/** Register `helm://` + `vigil://` as the OS default handler. */
	protocolHandlers: boolean
	/** Take the daemon scheduled-run resident lease. */
	scheduledResidency: boolean
	/** Construct scheduled attention adoption + notifier (daemon writes on restore/claim). */
	scheduledAttention: boolean
	/** Start polling/claiming scheduled attention notifications. */
	scheduledAttentionNotifier: boolean
	/** Start the shared `~/.helm/document-review` CLI control host. */
	documentReviewControl: boolean
	/** Any non-GET daemon request (task watch, restart, profiles, Items, config). */
	daemonWrites: boolean
	/** Pair/revoke in the shared Remote root. */
	remotePairingWrites: boolean
	/** Poll Okena and spool to `<userData>/agent-dock`. */
	agentDock: boolean
	windowTitle: string
}

export function startupPolicy(input: StartupPolicyInput): StartupPolicy {
	const harness = input.screenshot || input.attestation
	const owner = !harness && !input.sideBySide
	const dockForced = input.agentDockEnv === '1'
	const dockDisabled = input.agentDockEnv === '0'
	return {
		protocolHandlers: owner,
		scheduledResidency: owner,
		scheduledAttention: !input.attestation && !input.sideBySide,
		scheduledAttentionNotifier: owner,
		documentReviewControl: owner,
		daemonWrites: !input.sideBySide,
		remotePairingWrites: !input.sideBySide,
		agentDock:
			!input.attestation &&
			!dockDisabled &&
			(dockForced || input.sideBySide || (!input.screenshot && !input.customUserData && !input.tmpUserData)),
		windowTitle: input.sideBySide ? SIDE_BY_SIDE_TITLE : 'Helm',
	}
}
