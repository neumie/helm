import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentInvocation } from '../solver/agent-adapter.js'
import type { SolverAgent } from '../solver/agent.js'

const MAX_DESCRIPTOR_BYTES = 16 * 1024
const MAX_PROMPT_BYTES = 80 * 1024

export interface ScheduledInvocationDescriptor {
	cwd: string
	promptPath: string
	invocation: Omit<AgentInvocation, 'label'>
	shell: string
}

export interface ScheduledAgentEnvironmentInput {
	agent: SolverAgent
	daemonUrl: string
	runId: string
	reportCapability: string
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

export function writeScheduledPrompt(runDir: string, prompt: string): string {
	assertNoNul(prompt, 'Scheduled prompt')
	if (Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_BYTES)
		throw new Error('Scheduled prompt exceeds private-file limit')
	const path = join(resolve(runDir), 'prompt.txt')
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
	writeFileSync(path, prompt, { encoding: 'utf8', mode: 0o600 })
	chmodSync(path, 0o600)
	return path
}

export function writeInvocationDescriptor(runDir: string, descriptor: ScheduledInvocationDescriptor): string {
	validateInvocationDescriptor(descriptor)
	const path = join(resolve(runDir), 'invocation.json')
	const encoded = JSON.stringify(descriptor)
	if (Buffer.byteLength(encoded, 'utf8') > MAX_DESCRIPTOR_BYTES)
		throw new Error('Scheduled invocation descriptor too large')
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
	writeFileSync(path, encoded, { encoding: 'utf8', mode: 0o600 })
	chmodSync(path, 0o600)
	return path
}

export function readInvocationDescriptor(path: string): ScheduledInvocationDescriptor {
	const source = readFileSync(path)
	if (source.byteLength > MAX_DESCRIPTOR_BYTES) throw new Error('Scheduled invocation descriptor too large')
	const value = JSON.parse(source.toString('utf8')) as ScheduledInvocationDescriptor
	validateInvocationDescriptor(value)
	return value
}

export async function runScheduledAgentHost(descriptorPath: string, env = process.env): Promise<void> {
	const descriptor = readInvocationDescriptor(descriptorPath)
	const prompt = readFileSync(descriptor.promptPath)
	if (prompt.byteLength > MAX_PROMPT_BYTES) throw new Error('Scheduled prompt exceeds private-file limit')
	// The prompt is a single argv element, never executable shell source.
	await waitForChild(
		descriptor.invocation.command,
		composeScheduledAgentArgs(descriptor.invocation, prompt.toString('utf8')),
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

function validateInvocationDescriptor(value: ScheduledInvocationDescriptor): void {
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
