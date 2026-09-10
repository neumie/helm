import { randomUUID } from 'node:crypto'
import {
	constants,
	closeSync,
	fstatSync,
	lstatSync,
	openSync,
	readSync,
	readlinkSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from 'node:fs'
import { basename, dirname, join, normalize, resolve } from 'node:path'
import lockfile from 'proper-lockfile'

interface Fingerprint {
	dev: number
	ino: number
	size: number
	mtimeMs: number
}
interface PointerAttestation {
	path: string
	link?: string
	linkFingerprint: Fingerprint
	target: string
	targetFingerprint: Fingerprint
}
export interface RemotePiInstallPlan {
	settingsPath: string
	bridgeSource: string
	questionForkSource: string
	/** Existing canonical owner-private directory; keeps backups out of configuration repositories. */
	backupDirectory?: string
}
export interface PreparedRemotePiInstall {
	settingsPath: string
	canonicalTarget: string
	backupPath: string
	apply(): void
	rollback(): void
}

/**
 * A narrow transaction for the operator-approved resource selection only. It uses
 * Pi 0.85.1's actual proper-lockfile(pointerPath, { realpath: false }) key for
 * prepare/read/backup/apply/rollback, preserving Pi's logical settings pointer.
 */
export function prepareRemotePiInstall(plan: RemotePiInstallPlan): PreparedRemotePiInstall {
	const externalBackups = plan.backupDirectory === undefined ? undefined : privateBackupDirectory(plan.backupDirectory)
	let before: PointerAttestation | undefined
	let original = ''
	let backupPath = ''
	withPiSettingsLock(plan.settingsPath, () => {
		before = attest(plan.settingsPath)
		original = readAttested(before)
		backupPath = join(
			externalBackups ?? dirname(before.target),
			`.${basename(before.target)}.helm-remote-backup-${randomUUID()}`,
		)
		writeFileSync(backupPath, original, { mode: 0o600, flag: 'wx' })
	})
	if (!before) throw new Error('Pi settings preparation failed')
	const attestation = before
	const next = selectHelmResources(parseSettings(original), plan)
	let applied = false
	let appliedTarget: Fingerprint | undefined
	return {
		settingsPath: attestation.path,
		canonicalTarget: attestation.target,
		backupPath,
		apply() {
			if (applied) return
			withPiSettingsLock(attestation.path, () => {
				assertUnchanged(attestation)
				atomicWrite(attestation.target, `${JSON.stringify(next, null, 2)}\n`)
				appliedTarget = attest(attestation.path).targetFingerprint
				applied = true
			})
		},
		rollback() {
			if (!applied) {
				rmSync(backupPath, { force: true })
				return
			}
			withPiSettingsLock(attestation.path, () => {
				const current = attest(attestation.path)
				if (
					current.link !== attestation.link ||
					current.target !== attestation.target ||
					!appliedTarget ||
					!sameFingerprint(current.targetFingerprint, appliedTarget)
				)
					throw new Error('Pi settings changed after Remote installation; rollback refused')
				atomicWrite(attestation.target, readBoundedPrivateRegularFile(backupPath, 1024 * 1024, 'Pi settings backup'))
				applied = false
			})
		},
	}
}

function privateBackupDirectory(path: string): string {
	try {
		const directory = resolve(path)
		const stat = lstatSync(directory)
		if (
			!stat.isDirectory() ||
			stat.uid !== process.getuid?.() ||
			(stat.mode & 0o077) !== 0 ||
			realpathSync(directory) !== directory
		)
			throw new Error('unsafe_directory')
		return directory
	} catch {
		throw new Error('Remote backup directory must be an existing canonical owner-private directory')
	}
}

function withPiSettingsLock<T>(pointerPath: string, fn: () => T): T {
	const release = lockfile.lockSync(resolve(pointerPath), { realpath: false })
	try {
		return fn()
	} finally {
		release()
	}
}
function attest(path: string): PointerAttestation {
	const absolute = resolve(path)
	const linkStat = lstatSync(absolute)
	let target = absolute
	let link: string | undefined
	if (linkStat.isSymbolicLink()) {
		link = readlinkSync(absolute)
		target = resolve(dirname(absolute), link)
	}
	const targetStat = lstatSync(target)
	if (
		targetStat.isSymbolicLink() ||
		!targetStat.isFile() ||
		targetStat.nlink !== 1 ||
		targetStat.uid !== process.getuid?.()
	)
		throw new Error('Pi settings target is unsafe')
	if ((targetStat.mode & 0o022) !== 0 || targetStat.size > 1024 * 1024 || realpathSync(target) !== target)
		throw new Error('Pi settings target is unsafe')
	return {
		path: absolute,
		link,
		linkFingerprint: fingerprint(linkStat),
		target,
		targetFingerprint: fingerprint(targetStat),
	}
}
function readAttested(attestation: PointerAttestation): string {
	const fd = openSync(attestation.target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
	try {
		const stat = fstatSync(fd)
		if (
			!stat.isFile() ||
			stat.nlink !== 1 ||
			stat.uid !== process.getuid?.() ||
			!sameFingerprint(fingerprint(stat), attestation.targetFingerprint)
		)
			throw new Error('Pi settings changed while Remote installation was prepared')
		const bytes = Buffer.alloc(1024 * 1024 + 1)
		const length = readSync(fd, bytes, 0, bytes.length, 0)
		if (length > 1024 * 1024) throw new Error('Pi settings target is unsafe')
		return bytes.subarray(0, length).toString('utf8')
	} finally {
		closeSync(fd)
	}
}
function readBoundedPrivateRegularFile(path: string, maxBytes: number, label: string): string {
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
	try {
		const stat = fstatSync(fd)
		if (
			!stat.isFile() ||
			stat.nlink !== 1 ||
			stat.uid !== process.getuid?.() ||
			(stat.mode & 0o777) !== 0o600 ||
			stat.size > maxBytes
		)
			throw new Error(`${label} is unsafe`)
		const bytes = Buffer.alloc(maxBytes + 1)
		const length = readSync(fd, bytes, 0, bytes.length, 0)
		if (length > maxBytes) throw new Error(`${label} is unsafe`)
		return bytes.subarray(0, length).toString('utf8')
	} finally {
		closeSync(fd)
	}
}
function assertUnchanged(before: PointerAttestation): void {
	const current = attest(before.path)
	if (
		current.link !== before.link ||
		!sameFingerprint(current.linkFingerprint, before.linkFingerprint) ||
		current.target !== before.target ||
		!sameFingerprint(current.targetFingerprint, before.targetFingerprint)
	)
		throw new Error('Pi settings changed while Remote installation was prepared')
}
function fingerprint(stat: { dev: number; ino: number; size: number; mtimeMs: number }): Fingerprint {
	return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs }
}
function sameFingerprint(a: Fingerprint, b: Fingerprint): boolean {
	return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs
}
function parseSettings(value: string): Record<string, unknown> {
	const parsed = JSON.parse(value) as unknown
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Pi settings must be an object')
	return parsed as Record<string, unknown>
}
function selectHelmResources(document: Record<string, unknown>, plan: RemotePiInstallPlan): Record<string, unknown> {
	const packages = Array.isArray(document.packages) ? document.packages : []
	const selected = packages
		.filter(entry => !isQuestionnaire(entry) && !isQuestionnaireExtension(entry, plan))
		.filter(
			entry =>
				!isHelmSource(entry, plan.bridgeSource, plan.settingsPath) &&
				!isHelmSource(entry, plan.questionForkSource, plan.settingsPath),
		)
	// Pi's package filters match relative paths without './' (unlike manifest paths).
	selected.push(
		{ source: plan.questionForkSource, extensions: ['index.ts'] },
		{ source: plan.bridgeSource, extensions: ['index.ts'] },
	)
	const extensions = Array.isArray(document.extensions)
		? document.extensions.filter(entry => !isQuestionnaire(entry) && !isQuestionnaireExtension(entry, plan))
		: document.extensions
	return { ...document, packages: selected, ...(extensions === undefined ? {} : { extensions }) }
}
/** Exact resource entrypoints only, never substring matches in unrelated names. */
function isQuestionnaireExtension(value: unknown, plan: RemotePiInstallPlan): boolean {
	const source = resourceSource(value)
	if (!source || (!source.startsWith('/') && !source.startsWith('.'))) return false
	const path = normalize(source)
	if (path === normalize(join(plan.questionForkSource, 'index.ts'))) return true
	return (
		basename(path) === 'index.ts' &&
		['rpiv-ask-user-question', 'helm-ask-user-question'].includes(basename(dirname(path)))
	)
}
function isQuestionnaire(value: unknown): boolean {
	const source = resourceSource(value)
	return (
		packageIdentity(source) === '@juicesharp/rpiv-ask-user-question' ||
		packageIdentity(source) === '@neumie/helm-ask-user-question'
	)
}
function isHelmSource(value: unknown, source: string, settingsPath: string): boolean {
	const candidate = resourceSource(value)
	if (candidate === source) return true
	if (!candidate || (!candidate.startsWith('/') && !candidate.startsWith('.'))) return false
	return resolve(dirname(settingsPath), candidate) === resolve(dirname(settingsPath), source)
}
function resourceSource(value: unknown): string | null {
	if (typeof value === 'string') return value
	if (value && typeof value === 'object' && typeof (value as { source?: unknown }).source === 'string')
		return (value as { source: string }).source
	return null
}
/** Pi's npm parser treats npm:<name>@<version> as one package identity. */
function packageIdentity(source: string | null): string | null {
	if (!source) return null
	const spec = source.startsWith('npm:') ? source.slice(4).trim() : source
	for (const name of ['@juicesharp/rpiv-ask-user-question', '@neumie/helm-ask-user-question'])
		if (spec === name || spec.startsWith(`${name}@`)) return name
	return null
}
function atomicWrite(path: string, value: string): void {
	const temporary = join(dirname(path), `.${basename(path)}.helm-remote-${randomUUID()}.tmp`)
	try {
		writeFileSync(temporary, value, { mode: 0o600, flag: 'wx' })
		renameSync(temporary, path)
	} finally {
		rmSync(temporary, { force: true })
	}
}
