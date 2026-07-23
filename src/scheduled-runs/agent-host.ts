import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
	constants,
	type Stats,
	closeSync,
	fchmodSync,
	fstatSync,
	fsyncSync,
	lstatSync,
	openSync,
	readFileSync,
	realpathSync,
	writeSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentInvocation } from '../solver/agent-adapter.js'
import type { SolverAgent } from '../solver/agent.js'

const MAX_DESCRIPTOR_BYTES = 16 * 1024
const MAX_PROMPT_BYTES = 80 * 1024
const PRIVATE_FILE_MODE = 0o600
const PRIVATE_DIRECTORY_MODE = 0o700
const PROMPT_FILE = 'prompt.txt'
const INVOCATION_FILE = 'invocation.json'

export interface ScheduledArtifactIdentity {
	device: number
	inode: number
}

export interface ScheduledInvocationDescriptor {
	cwd: string
	promptPath: string
	invocation: Omit<AgentInvocation, 'label'>
	shell: string
	/** Canonical, daemon-created run directory captured while artifacts were written. */
	runDir: string
	runDirIdentity: ScheduledArtifactIdentity
	promptIdentity: ScheduledArtifactIdentity
}

type ScheduledInvocationInput = Omit<ScheduledInvocationDescriptor, 'runDir' | 'runDirIdentity' | 'promptIdentity'>

export interface ScheduledAgentEnvironmentInput {
	agent: SolverAgent
	daemonUrl: string
	runId: string
	reportCapability: string
}

interface RunDirectory {
	path: string
	identity: ScheduledArtifactIdentity
}

const ALLOWED_ENV = new Set([
	'PATH',
	'HOME',
	'USER',
	'LOGNAME',
	'SHELL',
	'TMPDIR',
	'LANG',
	'TERM',
	'COLORTERM',
	'SSH_AUTH_SOCK',
	'GH_TOKEN',
	'GITHUB_TOKEN',
])

const PROVIDER_CREDENTIAL: Record<SolverAgent, 'ANTHROPIC_API_KEY' | 'OPENAI_API_KEY'> = {
	claude: 'ANTHROPIC_API_KEY',
	codex: 'OPENAI_API_KEY',
}

/** Minimal environment is accidental-secret reduction, not system-target containment. */
export function scheduledAgentEnvironment(
	input: ScheduledAgentEnvironmentInput,
	parent: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = {}
	for (const [key, value] of Object.entries(parent)) {
		if (!value) continue
		if (ALLOWED_ENV.has(key) || key.startsWith('LC_')) environment[key] = value
	}
	const providerCredential = PROVIDER_CREDENTIAL[input.agent]
	if (parent[providerCredential]) environment[providerCredential] = parent[providerCredential]
	environment.HELM_SCHEDULED_DAEMON_URL = input.daemonUrl
	environment.HELM_SCHEDULED_RUN_ID = input.runId
	environment.HELM_SCHEDULED_REPORT_CAPABILITY = input.reportCapability
	return environment
}

/** Creates the prompt once; stale artifact paths are never followed, overwritten, or reconciled implicitly. */
export function writeScheduledPrompt(runDir: string, prompt: string): string {
	assertNoNul(prompt, 'Scheduled prompt')
	if (Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_BYTES)
		throw new Error('Scheduled prompt exceeds private-file limit')
	const run = inspectRunDirectory(runDir)
	return writePrivateArtifact(run, PROMPT_FILE, Buffer.from(prompt, 'utf8'))
}

/** Writes an invocation that binds the host to the exact run directory and prompt inode. */
export function writeInvocationDescriptor(runDir: string, input: ScheduledInvocationInput): string {
	validateInvocationInput(input)
	const run = inspectRunDirectory(runDir)
	const promptPath = artifactPath(run, PROMPT_FILE)
	if (resolve(input.promptPath) !== promptPath)
		throw new Error('Scheduled descriptor prompt must be the run prompt artifact')
	const promptIdentity = inspectPrivateArtifact(promptPath, 'Scheduled prompt')
	const descriptor: ScheduledInvocationDescriptor = {
		...input,
		promptPath,
		runDir: run.path,
		runDirIdentity: run.identity,
		promptIdentity,
	}
	const encoded = Buffer.from(JSON.stringify(descriptor), 'utf8')
	if (encoded.byteLength > MAX_DESCRIPTOR_BYTES) throw new Error('Scheduled invocation descriptor too large')
	return writePrivateArtifact(run, INVOCATION_FILE, encoded)
}

/** Reads only a no-follow private descriptor located in its captured run directory. */
export function readInvocationDescriptor(path: string): ScheduledInvocationDescriptor {
	const fd = openPrivateRead(path, 'Scheduled invocation descriptor')
	try {
		const source = readFileSync(fd)
		if (source.byteLength > MAX_DESCRIPTOR_BYTES) throw new Error('Scheduled invocation descriptor too large')
		const value = JSON.parse(source.toString('utf8')) as ScheduledInvocationDescriptor
		validateInvocationDescriptor(value)
		const run = inspectRunDirectory(value.runDir)
		assertIdentity(run.identity, value.runDirIdentity, 'Scheduled run directory')
		if (realpathSync(dirname(path)) !== run.path || resolve(path) !== artifactPath(run, INVOCATION_FILE)) {
			throw new Error('Scheduled invocation descriptor escaped its captured run directory')
		}
		return value
	} finally {
		closeSync(fd)
	}
}

/** Reopens the prompt no-follow and checks the descriptor's captured run and inode identities before reading it. */
export function readScheduledPrompt(descriptor: ScheduledInvocationDescriptor): string {
	const run = inspectRunDirectory(descriptor.runDir)
	assertIdentity(run.identity, descriptor.runDirIdentity, 'Scheduled run directory')
	if (resolve(descriptor.promptPath) !== artifactPath(run, PROMPT_FILE)) {
		throw new Error('Scheduled prompt escaped its captured run directory')
	}
	const fd = openPrivateRead(descriptor.promptPath, 'Scheduled prompt')
	try {
		assertIdentity(identityForStats(fstatSync(fd), 'Scheduled prompt'), descriptor.promptIdentity, 'Scheduled prompt')
		const prompt = readFileSync(fd)
		if (prompt.byteLength > MAX_PROMPT_BYTES) throw new Error('Scheduled prompt exceeds private-file limit')
		return prompt.toString('utf8')
	} finally {
		closeSync(fd)
	}
}

export async function runScheduledAgentHost(descriptorPath: string, env = process.env): Promise<void> {
	const descriptor = readInvocationDescriptor(descriptorPath)
	const prompt = readScheduledPrompt(descriptor)
	// The prompt is a single argv element, never executable shell source.
	await waitForChild(
		descriptor.invocation.command,
		composeScheduledAgentArgs(descriptor.invocation, prompt),
		descriptor.cwd,
		env,
	)
	// Agent exit is not completion. Keep a login shell available for report/diagnosis.
	await waitForChild(descriptor.shell || env.SHELL || '/bin/sh', ['-l'], descriptor.cwd, env)
}

/** The one scheduled-run argv composition seam: prompt-free adapter args plus one validated prompt. */
export function composeScheduledAgentArgs(invocation: Omit<AgentInvocation, 'label'>, prompt: string): string[] {
	if (!invocation.command || !Array.isArray(invocation.args)) throw new Error('Invalid scheduled invocation')
	assertNoNul(invocation.command, 'Scheduled command')
	for (const arg of invocation.args) assertNoNul(arg, 'Scheduled argument')
	assertNoNul(prompt, 'Scheduled prompt')
	return [...invocation.args, prompt]
}

function writePrivateArtifact(run: RunDirectory, name: string, content: Buffer): string {
	const path = artifactPath(run, name)
	let fd: number | null = null
	try {
		fd = openSync(
			path,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
			PRIVATE_FILE_MODE,
		)
		fchmodSync(fd, PRIVATE_FILE_MODE)
		const identity = identityForStats(fstatSync(fd), `Scheduled ${name}`)
		writeAll(fd, content)
		fsyncSync(fd)
		assertIdentity(inspectRunDirectory(run.path).identity, run.identity, 'Scheduled run directory')
		assertIdentity(inspectPrivateArtifact(path, `Scheduled ${name}`), identity, `Scheduled ${name}`)
		return path
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw staleArtifactError(path)
		throw error
	} finally {
		if (fd !== null) closeSync(fd)
	}
}

function writeAll(fd: number, content: Buffer): void {
	for (let offset = 0; offset < content.byteLength; ) {
		const written = writeSync(fd, content, offset, content.byteLength - offset)
		if (written <= 0) throw new Error('Failed to write scheduled private artifact')
		offset += written
	}
}

function openPrivateRead(path: string, label: string): number {
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
	try {
		identityForStats(fstatSync(fd), label)
		return fd
	} catch (error) {
		closeSync(fd)
		throw error
	}
}

function inspectRunDirectory(path: string): RunDirectory {
	const resolved = resolve(path)
	const stats = lstatSync(resolved)
	if (!stats.isDirectory() || stats.isSymbolicLink())
		throw new Error('Scheduled run directory must be a real directory')
	const owner = process.getuid?.()
	if (owner !== undefined && stats.uid !== owner)
		throw new Error('Scheduled run directory must be owned by the daemon user')
	if ((stats.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) throw new Error('Scheduled run directory must have mode 0700')
	return { path: realpathSync(resolved), identity: { device: stats.dev, inode: stats.ino } }
}

function inspectPrivateArtifact(path: string, label: string): ScheduledArtifactIdentity {
	return identityForStats(lstatSync(path), label)
}

function identityForStats(stats: Stats, label: string): ScheduledArtifactIdentity {
	if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`${label} must be a regular file`)
	const owner = process.getuid?.()
	if (owner !== undefined && stats.uid !== owner) throw new Error(`${label} must be owned by the daemon user`)
	if ((stats.mode & 0o777) !== PRIVATE_FILE_MODE) throw new Error(`${label} must have mode 0600`)
	return { device: stats.dev, inode: stats.ino }
}

function assertIdentity(actual: ScheduledArtifactIdentity, expected: ScheduledArtifactIdentity, label: string): void {
	if (actual.device !== expected.device || actual.inode !== expected.inode) throw new Error(`${label} was replaced`)
}

function artifactPath(run: RunDirectory, name: string): string {
	const path = join(run.path, name)
	const rel = relative(run.path, path)
	if (rel === '' || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) {
		throw new Error('Scheduled artifact escaped its run directory')
	}
	return path
}

function staleArtifactError(path: string): Error {
	try {
		const stale = lstatSync(path)
		return new Error(
			stale.size > 0
				? 'Scheduled nonempty stale artifact path already exists'
				: 'Scheduled stale artifact path already exists',
		)
	} catch {
		return new Error('Scheduled artifact path already exists')
	}
}

function validateInvocationInput(value: ScheduledInvocationInput): void {
	if (
		!value ||
		!isAbsolute(value.cwd) ||
		!isAbsolute(value.promptPath) ||
		!value.invocation?.command ||
		!Array.isArray(value.invocation.args)
	) {
		throw new Error('Invalid scheduled invocation descriptor')
	}
	assertNoNul(value.cwd, 'Scheduled cwd')
	assertNoNul(value.promptPath, 'Scheduled prompt path')
	assertNoNul(value.shell, 'Scheduled shell')
	composeScheduledAgentArgs(value.invocation, '')
}

function validateInvocationDescriptor(value: ScheduledInvocationDescriptor): void {
	validateInvocationInput(value)
	if (!isAbsolute(value.runDir) || !validIdentity(value.runDirIdentity) || !validIdentity(value.promptIdentity)) {
		throw new Error('Invalid scheduled invocation descriptor')
	}
	assertNoNul(value.runDir, 'Scheduled run directory')
}

function validIdentity(value: ScheduledArtifactIdentity): boolean {
	return (
		!!value &&
		Number.isSafeInteger(value.device) &&
		value.device >= 0 &&
		Number.isSafeInteger(value.inode) &&
		value.inode >= 0
	)
}

function assertNoNul(value: string, label: string): void {
	if (typeof value !== 'string' || value.includes('\0')) throw new Error(`${label} must not contain NUL`)
}

function waitForChild(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
	assertNoNul(command, 'Scheduled command')
	assertNoNul(cwd, 'Scheduled cwd')
	for (const arg of args) assertNoNul(arg, 'Scheduled argument')
	return new Promise((resolveChild, reject) => {
		const child = spawn(command, args, { cwd, env, stdio: 'inherit' })
		child.once('error', reject)
		child.once('exit', () => resolveChild())
	})
}

/** Node argv used after `dtach -n <socket>`; it never invokes a shell. */
export function scheduledAgentHostArgs(descriptorPath: string): string[] {
	return [fileURLToPath(import.meta.url), '--scheduled-agent-host', descriptorPath]
}

if (process.argv[2] === '--scheduled-agent-host' && process.argv[3]) {
	runScheduledAgentHost(process.argv[3]).catch(error => {
		process.stderr.write(
			`scheduled agent host failed (${randomUUID()}): ${error instanceof Error ? error.message : String(error)}\n`,
		)
		process.exitCode = 1
	})
}
