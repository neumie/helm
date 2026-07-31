import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'

export interface ProfileSwitchAttestationLaunch {
	root: string
	userDataDir: string
	socketRoot: string
	homeDir: string
	evidencePath: string
	marker: string
}

type AttestationEnvironment = Record<string, string | undefined>

function argumentValue(argv: string[], prefix: string): string | null {
	return argv.find(argument => argument.startsWith(prefix))?.slice(prefix.length) ?? null
}

function requireExactPath(actual: string | undefined | null, expected: string, label: string): void {
	if (!actual || resolve(actual) !== expected)
		throw new Error(`Profile-switch attestation ${label} escaped its isolated root`)
}

function requirePrivatePath(path: string, root: string, label: string): void {
	const resolvedRoot = resolve(root)
	const resolvedPath = resolve(path)
	const lexicalRelative = relative(resolvedRoot, resolvedPath)
	if (lexicalRelative.startsWith('..')) throw new Error(`Profile-switch attestation ${label} escaped its isolated root`)
	const candidates = [resolvedRoot]
	let current = resolvedRoot
	for (const segment of lexicalRelative.split('/').filter(Boolean)) {
		current = join(current, segment)
		candidates.push(current)
	}
	for (const candidate of candidates) {
		const info = lstatSync(candidate)
		if (info.isSymbolicLink() || !info.isDirectory()) {
			throw new Error(`Profile-switch attestation ${label} must be a private non-symlink directory tree`)
		}
		if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
			throw new Error(`Profile-switch attestation ${label} is not owned by this user`)
		}
		if ((info.mode & 0o077) !== 0) throw new Error(`Profile-switch attestation ${label} is not private`)
	}
	const canonicalRoot = realpathSync(resolvedRoot)
	const canonicalPath = realpathSync(resolvedPath)
	const canonicalRelative = relative(canonicalRoot, canonicalPath)
	if (canonicalRelative.startsWith('..')) {
		throw new Error(`Profile-switch attestation ${label} escaped its isolated root`)
	}
}

/**
 * Parse and fail-closed validate the private Electron attestation launch.
 * This runs before any profile/session store is constructed, so a malformed
 * canary can never open or prune the operator's real Helm namespace.
 */
export function parseProfileSwitchAttestationLaunch(
	argv: string[],
	env: AttestationEnvironment,
): ProfileSwitchAttestationLaunch | null {
	const evidenceArgument = argumentValue(argv, '--profile-switch-attestation=')
	if (evidenceArgument === null) return null

	const rootArgument = env.HELM_PROFILE_SWITCH_ATTESTATION_ROOT
	if (!rootArgument) throw new Error('Profile-switch attestation requires an isolated root')
	const root = resolve(rootArgument)
	const canonicalTemp = realpathSync(tmpdir())
	const canonicalRoot = realpathSync(root)
	const rootFromTemp = relative(canonicalTemp, canonicalRoot)
	if (basename(root).startsWith('hpsa-') === false || rootFromTemp.startsWith('..') || rootFromTemp === '') {
		throw new Error('Profile-switch attestation root must be a private hpsa-* temp directory')
	}
	requirePrivatePath(root, root, 'root')

	const userDataDir = join(root, 'user-data')
	const socketRoot = join(root, 's')
	const homeDir = join(root, 'home')
	const evidencePath = join(root, 'child-evidence.json')
	requireExactPath(argumentValue(argv, '--user-data-dir='), userDataDir, 'userData path')
	requireExactPath(env.HELM_SOCKET_DIR, socketRoot, 'socket path')
	requireExactPath(env.HOME, homeDir, 'HOME')
	requireExactPath(env.ZDOTDIR, homeDir, 'ZDOTDIR')
	requireExactPath(env.HISTFILE, join(homeDir, '.zsh_history'), 'HISTFILE')
	requireExactPath(env.XDG_CONFIG_HOME, join(homeDir, '.config'), 'XDG config path')
	requireExactPath(env.XDG_STATE_HOME, join(homeDir, '.local', 'state'), 'XDG state path')
	requireExactPath(env.XDG_CACHE_HOME, join(homeDir, '.cache'), 'XDG cache path')
	requireExactPath(env.XDG_DATA_HOME, join(homeDir, '.local', 'share'), 'XDG data path')
	requireExactPath(env.XDG_RUNTIME_DIR, join(homeDir, '.runtime'), 'XDG runtime path')
	requireExactPath(evidenceArgument, evidencePath, 'evidence path')
	for (const [path, label] of [
		[userDataDir, 'userData directory'],
		[socketRoot, 'socket directory'],
		[homeDir, 'HOME directory'],
		[join(homeDir, '.config'), 'XDG config directory'],
		[join(homeDir, '.local', 'state'), 'XDG state directory'],
		[join(homeDir, '.cache'), 'XDG cache directory'],
		[join(homeDir, '.local', 'share'), 'XDG data directory'],
		[join(homeDir, '.runtime'), 'XDG runtime directory'],
	] as const) {
		requirePrivatePath(path, root, label)
	}

	const capabilityPath = join(root, '.attestation-capability')
	const capabilityInfo = lstatSync(capabilityPath)
	if (capabilityInfo.isSymbolicLink() || !capabilityInfo.isFile() || (capabilityInfo.mode & 0o077) !== 0) {
		throw new Error('Profile-switch attestation capability file is not private')
	}
	if (typeof process.getuid === 'function' && capabilityInfo.uid !== process.getuid()) {
		throw new Error('Profile-switch attestation capability file is not owned by this user')
	}
	const expectedCapability = readFileSync(capabilityPath, 'utf8').trim()
	if (!expectedCapability || env.HELM_PROFILE_SWITCH_ATTESTATION_CAPABILITY !== expectedCapability) {
		throw new Error('Profile-switch attestation capability mismatch')
	}

	const marker = argumentValue(argv, '--profile-switch-attestation-marker=')?.trim()
	if (!marker || marker.length > 200) throw new Error('Profile-switch attestation marker is missing or invalid')
	if (dirname(evidencePath) !== root || statSync(root).isDirectory() === false) {
		throw new Error('Profile-switch attestation evidence path escaped its isolated root')
	}
	return { root, userDataDir, socketRoot, homeDir, evidencePath, marker }
}

export default { parseProfileSwitchAttestationLaunch }
