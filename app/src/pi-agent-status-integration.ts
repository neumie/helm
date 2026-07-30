import { randomUUID } from 'node:crypto'
import { link, lstat, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const MANAGED_MARKER = '// HELM_MANAGED_PI_AGENT_STATUS_V1'
const FILE_NAME = 'helm-agent-status.ts'

export type PiAgentStatusIntegrationStatus =
	| 'installed'
	| 'external'
	| 'outdated'
	| 'not-installed'
	| 'conflict'
	| 'unavailable'

export interface PiAgentStatusIntegrationSnapshot {
	status: PiAgentStatusIntegrationStatus
	path: string
	message: string
}

export interface PiAgentStatusIntegrationOptions {
	home?: string
	env?: NodeJS.ProcessEnv
}

export const PI_AGENT_STATUS_EXTENSION_SOURCE = `${MANAGED_MARKER}
// Standalone package: https://github.com/neumie/pi-agent-status
// Installed and updated by Helm through Settings → Agent integrations.
// This extension is inert outside ordinary Helm terminal sessions.
// @ts-nocheck

import { randomUUID } from "node:crypto";

const enabled = process.env.HELM_TERMINAL_AGENT_STATUS === "1";
const instance = randomUUID().replace(/-/g, "_");
let seq = 0;
let active = false;
let tuiSession = false;
let heartbeat;
const tools = new Map();
const cooperativeBlocks = new Set();

function safeToolName(value) {
  const normalized = String(value ?? "tool").replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 40);
  return normalized || "tool";
}

function encode(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function currentReport() {
  if (cooperativeBlocks.size > 0) {
    return { state: "blocked", phase: { kind: "waiting", reason: "cooperative" } };
  }
  const question = [...tools.values()].some((name) => name === "ask_user_question");
  if (question) {
    return { state: "blocked", phase: { kind: "waiting", reason: "question" } };
  }
  if (!active) return { state: "idle" };
  if (tools.size > 0) {
    const names = [...tools.values()];
    return { state: "working", phase: { kind: "tool", name: names.at(-1), count: Math.min(16, names.length) } };
  }
  return { state: "working", phase: { kind: "thinking" } };
}

function emitReport(report = currentReport()) {
  if (!enabled) return;
  const payload = { v: 1, agent: "pi", instance, seq: ++seq, ...report };
  process.stdout.write("\\u001b]777;helm-agent-state;" + encode(payload) + "\\u0007");
}

function publish() {
  emitReport();
}

export default function (pi) {
  if (!enabled) return;

  pi.on("session_start", (_event, ctx) => {
    if (ctx?.mode !== "tui") return;
    tuiSession = true;
    active = ctx?.isIdle?.() === false;
    publish();
    clearInterval(heartbeat);
    heartbeat = setInterval(publish, 2000);
    heartbeat.unref?.();
  });

  pi.on("agent_start", () => {
    if (!tuiSession) return;
    active = true;
    publish();
  });

  pi.on("tool_execution_start", (event) => {
    if (!tuiSession) return;
    tools.set(String(event.toolCallId), safeToolName(event.toolName));
    publish();
  });

  pi.on("tool_execution_end", (event) => {
    if (!tuiSession) return;
    tools.delete(String(event.toolCallId));
    publish();
  });

  pi.events.on("helm:blocked", (event) => {
    if (!tuiSession) return;
    const key = String(event?.id ?? "default").slice(0, 80);
    if (event?.active) cooperativeBlocks.add(key);
    else cooperativeBlocks.delete(key);
    publish();
  });

  // agent_end may auto-retry or continue queued work; agent_settled is the
  // authoritative no-more-automatic-work boundary for status integrations.
  pi.on("agent_settled", (_event, ctx) => {
    if (!tuiSession || ctx?.isIdle?.() !== true) return;
    active = false;
    tools.clear();
    cooperativeBlocks.clear();
    publish();
  });

  pi.on("session_shutdown", () => {
    if (!tuiSession) return;
    clearInterval(heartbeat);
    heartbeat = undefined;
    tools.clear();
    cooperativeBlocks.clear();
    emitReport({ state: "absent" });
    tuiSession = false;
  });
}
`

function integrationPath(options: PiAgentStatusIntegrationOptions = {}): {
	agentDir: string
	extensionsDir: string
	file: string
	settings: string
} {
	const env = options.env ?? process.env
	const agentDir = env.PI_CODING_AGENT_DIR || join(options.home ?? homedir(), '.pi', 'agent')
	const extensionsDir = join(agentDir, 'extensions')
	return {
		agentDir,
		extensionsDir,
		file: join(extensionsDir, FILE_NAME),
		settings: join(agentDir, 'settings.json'),
	}
}

async function safeDirectory(path: string): Promise<'directory' | 'missing' | 'unsafe'> {
	try {
		const stat = await lstat(path)
		return stat.isDirectory() && !stat.isSymbolicLink() ? 'directory' : 'unsafe'
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unsafe'
	}
}

const MAX_SETTINGS_BYTES = 512 * 1024

function isAgentStatusPackage(value: unknown): boolean {
	if (typeof value !== 'string') return false
	const normalized = value.replaceAll('\\', '/').replace(/\/+$/, '')
	return (
		normalized === 'git:github.com/neumie/pi-agent-status' ||
		normalized === 'npm:@neumie/pi-agent-status' ||
		normalized.endsWith('/pi-agent-status') ||
		normalized.endsWith('/pi-agent-status.git')
	)
}

async function hasExternalPackage(settingsPath: string): Promise<boolean> {
	try {
		const metadata = await stat(settingsPath)
		if (!metadata.isFile() || metadata.size > MAX_SETTINGS_BYTES) return false
		const parsed = JSON.parse(await readFile(settingsPath, 'utf8')) as { packages?: unknown }
		return Array.isArray(parsed.packages) && parsed.packages.some(isAgentStatusPackage)
	} catch {
		return false
	}
}

async function inspect(options: PiAgentStatusIntegrationOptions = {}): Promise<PiAgentStatusIntegrationSnapshot> {
	const paths = integrationPath(options)
	if ((await safeDirectory(paths.agentDir)) !== 'directory') {
		return {
			status: 'unavailable',
			path: paths.file,
			message: 'Pi agent directory is unavailable. Install or run Pi first.',
		}
	}
	const extensions = await safeDirectory(paths.extensionsDir)
	if (extensions === 'unsafe')
		return { status: 'unavailable', path: paths.file, message: 'Pi extensions directory is not a safe directory.' }
	try {
		const stat = await lstat(paths.file)
		if (!stat.isFile() || stat.isSymbolicLink())
			return { status: 'conflict', path: paths.file, message: 'A non-file entry already uses Helm’s integration path.' }
		const content = await readFile(paths.file, 'utf8')
		if (!content.startsWith(MANAGED_MARKER))
			return {
				status: 'conflict',
				path: paths.file,
				message: 'An unmanaged Pi extension already uses Helm’s integration path.',
			}
		return content === PI_AGENT_STATUS_EXTENSION_SOURCE && (stat.mode & 0o777) === 0o600
			? { status: 'installed', path: paths.file, message: 'Precise Pi terminal status is installed.' }
			: { status: 'outdated', path: paths.file, message: 'A Helm-managed Pi status integration update is available.' }
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			if (await hasExternalPackage(paths.settings)) {
				return {
					status: 'external',
					path: paths.file,
					message: 'Precise Pi terminal status is managed by a Pi package.',
				}
			}
			return {
				status: 'not-installed',
				path: paths.file,
				message: 'Install the Pi integration for precise terminal status.',
			}
		}
		return { status: 'unavailable', path: paths.file, message: 'Could not inspect the Pi status integration.' }
	}
}

export class PiAgentStatusIntegration {
	readonly #options: PiAgentStatusIntegrationOptions

	constructor(options: PiAgentStatusIntegrationOptions = {}) {
		this.#options = options
	}

	status(): Promise<PiAgentStatusIntegrationSnapshot> {
		return inspect(this.#options)
	}

	async install(): Promise<PiAgentStatusIntegrationSnapshot> {
		const before = await inspect(this.#options)
		if (before.status === 'installed' || before.status === 'external') return before
		if (before.status === 'conflict' || before.status === 'unavailable') throw new Error(before.message)
		const paths = integrationPath(this.#options)
		if ((await safeDirectory(paths.extensionsDir)) === 'missing') await mkdir(paths.extensionsDir, { mode: 0o700 })
		if ((await safeDirectory(paths.extensionsDir)) !== 'directory')
			throw new Error('Pi extensions directory is not safe')
		const temporary = join(paths.extensionsDir, `.${FILE_NAME}.${randomUUID()}.tmp`)
		try {
			const handle = await open(temporary, 'wx', 0o600)
			try {
				await handle.writeFile(PI_AGENT_STATUS_EXTENSION_SOURCE, 'utf8')
				await handle.chmod(0o600)
				await handle.sync()
			} finally {
				await handle.close()
			}
			if (before.status === 'not-installed') {
				// Atomic no-overwrite publication closes the preflight race with an
				// unmanaged file appearing at Helm's reserved path.
				await link(temporary, paths.file)
				await rm(temporary)
			} else {
				// Recheck ownership after every preparation await. Rename is reserved
				// for the same Helm-managed update state observed at admission.
				if ((await inspect(this.#options)).status !== 'outdated')
					throw new Error('Pi status integration changed while preparing its update')
				await rename(temporary, paths.file)
			}
		} catch (error) {
			await rm(temporary, { force: true })
			throw error
		}
		return inspect(this.#options)
	}

	async remove(): Promise<PiAgentStatusIntegrationSnapshot> {
		const before = await inspect(this.#options)
		if (before.status === 'external') return before
		if (before.status === 'conflict') throw new Error(before.message)
		if (before.status === 'installed' || before.status === 'outdated') {
			const current = await inspect(this.#options)
			if (current.status !== before.status) throw new Error('Pi status integration changed before removal')
			await rm(before.path)
		}
		return inspect(this.#options)
	}
}

export default { PiAgentStatusIntegration, PI_AGENT_STATUS_EXTENSION_SOURCE }
