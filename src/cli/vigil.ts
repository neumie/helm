#!/usr/bin/env node

import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { STDERR_LOG, STDOUT_LOG, getPid, isLoaded, load, unload } from './launchd.js'

const HELP = `Usage: vigil <command>

Commands:
  start    Start the Vigil daemon
  stop     Stop the Vigil daemon
  status   Show daemon status
  logs     Tail daemon logs (--err for stderr)
  add      Create queued Item(s)
  ingest   File a self-contained task (email, note, …) into a project
  help     Show this help message`

const INGEST_HELP = `Usage: vigil ingest --project <slug> --title <title> [options]

File a self-contained task — an email, an Obsidian note, anything tied to a
project — into Vigil. Posts to the RUNNING daemon's /api/items/ingest, so it
works from ANY directory (no vigil.config.json needed) and any agent can use it.
The task lands in triage with a security-aware assessment; you approve it in the
dashboard, then it solves with its attachments available to the agent.

Required:
  --project <slug>        Vigil project slug
  --title <title>         Short task title

Options:
  --body <text>           Task description (inline)
  --body-file <path>      Read the description from a file (markdown/text)
  --attach <path>         Attach a file (repeatable; max 20, 25MB total)
  --meta <key=value>      Add a metadata line (repeatable, e.g. --meta From=a@b.com)
  --source-label <label>  Provenance label shown as the source (default: Manual)
  --external-id <id>      Idempotency key — re-ingesting the same id returns the
                          existing Item instead of a duplicate
  --source-url <url>      http(s) link back to the original
  --url <baseUrl>         Daemon base URL (default: $VIGIL_URL or http://localhost:7474)`

const ADD_HELP = `Usage: vigil add <kind> [options]

Create queued Item(s) by POSTing to the RUNNING daemon's /api/items. Like
\`vigil ingest\`, it is a thin HTTP client: it works from ANY directory (no
vigil.config.json needed), the daemon owns the DB and wakes its own queue, and
any agent can call it. The daemon must be running (\`vigil start\`).

Kinds:
  solve    Requires --project, --title, --prompt
  ralph    Requires --project, --title, --prd-path
  harden   Requires --project, --title, --target

Common options:
  --project <slug>        Project slug
  --title <title>         Item title
  --base-ref <ref>        Git ref to branch from
  --base-item <id>        Existing Item branch to branch from
  --spawner <name>        Planning Spawner preference
  --parallelism <n>       Number of sibling Items to create
  --url <baseUrl>         Daemon base URL (default: $VIGIL_URL or http://localhost:7474)

Ralph options:
  --prd-path <path>       PRD path
  --mode <once|afk>       Ralph mode
  --provider <name>       claude or codex
  --model <model>         Agent model
  --effort <effort>       Agent effort
  --iterations <n>        AFK iterations
  --no-oversee            Disable overseer

Harden options:
  --target <path>         Target file, directory, PR, or module
  --rounds <n>            Harden rounds`

function start(): void {
	try {
		load()
		console.log('Vigil daemon started.')
		console.log(`Logs: ${STDOUT_LOG}`)
	} catch (err) {
		console.error(`Error: ${err instanceof Error ? err.message : err}`)
		process.exit(1)
	}
}

function stop(): void {
	try {
		unload()
		console.log('Vigil daemon stopped.')
	} catch (err) {
		console.error(`Error: ${err instanceof Error ? err.message : err}`)
		process.exit(1)
	}
}

function status(): void {
	if (!isLoaded()) {
		console.log('Vigil is not running.')
		process.exit(1)
	}
	const pid = getPid()
	console.log(`Vigil is running.${pid ? ` (PID: ${pid})` : ''}`)
}

function logs(): void {
	const useStderr = process.argv.includes('--err')
	const logFile = useStderr ? STDERR_LOG : STDOUT_LOG

	if (!existsSync(logFile)) {
		console.error(`Log file not found: ${logFile}`)
		console.error('Has Vigil been started at least once?')
		process.exit(1)
	}

	try {
		execSync(`tail -f "${logFile}"`, { stdio: 'inherit' })
	} catch {
		// User hit Ctrl+C to exit tail — expected
	}
}

function optionValue(args: string[], name: string): string | undefined {
	const idx = args.indexOf(name)
	if (idx === -1) return undefined
	const value = args[idx + 1]
	if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`)
	return value
}

function optionValueAny(args: string[], names: string[]): string | undefined {
	for (const name of names) {
		const value = optionValue(args, name)
		if (value !== undefined) return value
	}
	return undefined
}

/** Collect every value for a repeatable option (e.g. --attach a --attach b). */
function optionValues(args: string[], name: string): string[] {
	const out: string[] = []
	for (let i = 0; i < args.length; i++) {
		if (args[i] !== name) continue
		const value = args[i + 1]
		if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`)
		out.push(value)
		i++
	}
	return out
}

function requiredOption(args: string[], name: string): string {
	const value = optionValue(args, name)
	if (!value) throw new Error(`Missing required option: ${name}`)
	return value
}

function positiveIntegerOption(args: string[], name: string): number | undefined {
	const value = optionValue(args, name)
	if (value === undefined) return undefined
	const parsed = Number(value)
	if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`)
	return parsed
}

function enumOption<T extends string>(args: string[], name: string, allowed: readonly T[]): T | undefined {
	const value = optionValue(args, name)
	if (value === undefined) return undefined
	if (!allowed.includes(value as T)) throw new Error(`${name} must be one of: ${allowed.join(', ')}`)
	return value as T
}

/** Daemon base URL: --url ?? $VIGIL_URL ?? localhost:7474. No config file is read. */
function resolveBaseUrl(args: string[]): string {
	return (optionValue(args, '--url') ?? process.env.VIGIL_URL ?? 'http://localhost:7474').replace(/\/+$/, '')
}

/** POST a JSON payload to the running daemon and unwrap its `{ data | error }` envelope. */
async function postToDaemon<T>(baseUrl: string, path: string, payload: unknown): Promise<T> {
	let res: Response
	try {
		res = await fetch(`${baseUrl}${path}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload),
		})
	} catch (err) {
		throw new Error(
			`Could not reach the Vigil daemon at ${baseUrl} — is it running? Start it with \`vigil start\`, or set --url / $VIGIL_URL. (${err instanceof Error ? err.message : err})`,
		)
	}
	const json = (await res.json().catch(() => ({}))) as { data?: T; error?: string }
	if (!res.ok) throw new Error(json.error ?? `Request failed: HTTP ${res.status}`)
	return json.data as T
}

/**
 * Map `vigil add <kind> …` args to a POST /api/items payload. Undefined optional
 * fields drop out of the JSON, so the route's strict schema accepts the body; the
 * daemon (not the CLI) validates spawner installs and creates the rows. Kept thin
 * on purpose — the daemon is the single owner of Item creation.
 */
function buildAddPayload(args: string[]): Record<string, unknown> {
	const kind = args[0]
	if (kind !== 'solve' && kind !== 'ralph' && kind !== 'harden') {
		throw new Error(`Unknown Item kind: ${kind}`)
	}
	const common = {
		title: requiredOption(args, '--title'),
		projectSlug: requiredOption(args, '--project'),
		baseRef: optionValue(args, '--base-ref'),
		baseItemId: optionValue(args, '--base-item'),
		spawner: optionValue(args, '--spawner'),
		parallelism: positiveIntegerOption(args, '--parallelism'),
	}
	if (kind === 'solve') {
		return { kind, ...common, prompt: requiredOption(args, '--prompt') }
	}
	if (kind === 'ralph') {
		return {
			kind,
			...common,
			prdPath: optionValueAny(args, ['--prd-path', '--prd']) ?? requiredOption(args, '--prd-path'),
			mode: enumOption(args, '--mode', ['once', 'afk'] as const),
			provider: enumOption(args, '--provider', ['claude', 'codex'] as const),
			model: optionValue(args, '--model'),
			effort: optionValue(args, '--effort'),
			iterations: positiveIntegerOption(args, '--iterations'),
			noOversee: args.includes('--no-oversee') ? true : undefined,
		}
	}
	return { kind, ...common, target: requiredOption(args, '--target'), rounds: positiveIntegerOption(args, '--rounds') }
}

async function add(): Promise<void> {
	const args = process.argv.slice(3)
	if (args.includes('--help') || args.includes('-h') || args.length === 0) {
		console.log(ADD_HELP)
		process.exit(args.length === 0 ? 1 : 0)
	}

	const payload = buildAddPayload(args)
	const baseUrl = resolveBaseUrl(args)
	const data = await postToDaemon<{ id: string } | Array<{ id: string }>>(baseUrl, '/api/items', payload)
	const items = Array.isArray(data) ? data : [data]
	const noun = items.length === 1 ? 'Item' : 'Items'
	console.log(`Created ${items.length} ${String(payload.kind)} ${noun}: ${items.map(item => item.id).join(', ')}`)
	console.log(`Track them at ${baseUrl}/`)
}

async function ingest(): Promise<void> {
	const args = process.argv.slice(3)
	if (args.includes('--help') || args.includes('-h') || args.length === 0) {
		console.log(INGEST_HELP)
		process.exit(args.length === 0 ? 1 : 0)
	}

	const project = requiredOption(args, '--project')
	const title = requiredOption(args, '--title')
	const bodyFile = optionValue(args, '--body-file')
	const body = bodyFile ? readFileSync(bodyFile, 'utf-8') : optionValue(args, '--body')

	const attachments = optionValues(args, '--attach').map(path => ({
		name: basename(path),
		dataBase64: readFileSync(path).toString('base64'),
	}))

	const metadata: Record<string, string> = {}
	for (const entry of optionValues(args, '--meta')) {
		const eq = entry.indexOf('=')
		if (eq === -1) throw new Error(`--meta must be key=value: ${entry}`)
		metadata[entry.slice(0, eq)] = entry.slice(eq + 1)
	}

	const source: { label: string; externalId?: string; url?: string } = {
		label: optionValue(args, '--source-label') ?? 'Manual',
	}
	const externalId = optionValue(args, '--external-id')
	if (externalId) source.externalId = externalId
	const sourceUrl = optionValue(args, '--source-url')
	if (sourceUrl) source.url = sourceUrl

	const payload = {
		projectSlug: project,
		title,
		...(body ? { body } : {}),
		...(Object.keys(metadata).length > 0 ? { metadata } : {}),
		source,
		...(attachments.length > 0 ? { attachments } : {}),
	}

	const baseUrl = resolveBaseUrl(args)
	const item = await postToDaemon<{ id: string; status: string }>(baseUrl, '/api/items/ingest', payload)
	console.log(`Ingested into ${project}: ${item?.id} (${item?.status})`)
	console.log(`Review and approve it at ${baseUrl}/`)
}

const command = process.argv[2]

switch (command) {
	case 'start':
		start()
		break
	case 'stop':
		stop()
		break
	case 'status':
		status()
		break
	case 'logs':
		logs()
		break
	case 'add':
		add().catch(err => {
			console.error(`Error: ${err instanceof Error ? err.message : err}`)
			process.exit(1)
		})
		break
	case 'ingest':
		ingest().catch(err => {
			console.error(`Error: ${err instanceof Error ? err.message : err}`)
			process.exit(1)
		})
		break
	case 'help':
	case '--help':
	case '-h':
	case undefined:
		console.log(HELP)
		break
	default:
		console.error(`Unknown command: ${command}`)
		console.log(HELP)
		process.exit(1)
}
