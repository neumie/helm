#!/usr/bin/env node

import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { STDERR_LOG, STDOUT_LOG, getPid, isLoaded, load, unload } from './launchd.js'

const HELP = `Usage: vigil <command>

Commands:
  start    Start the Vigil daemon
  stop     Stop the Vigil daemon
  status   Show daemon status
  logs     Tail daemon logs (--err for stderr)
  add      Create queued Item(s)
  help     Show this help message`

const ADD_HELP = `Usage: vigil add <kind> [options]

Create queued Item(s) through Item Commands.

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

async function add(): Promise<void> {
	const args = process.argv.slice(3)
	if (args.includes('--help') || args.includes('-h') || args.length === 0) {
		console.log(ADD_HELP)
		process.exit(args.length === 0 ? 1 : 0)
	}

	const kind = args[0]
	if (kind !== 'solve' && kind !== 'ralph' && kind !== 'harden') {
		throw new Error(`Unknown Item kind: ${kind}`)
	}

	const { loadConfig } = await import('../config.js')
	const { DB } = await import('../db/client.js')
	const { ItemCommands } = await import('../items/commands.js')
	const { listSpawnerAdapters, spawnerNameSchema } = await import('../spawner/registry.js')

	const { config } = loadConfig()
	const db = new DB()
	try {
		const spawner = optionValue(args, '--spawner')
		if (spawner) {
			const parsed = spawnerNameSchema.safeParse(spawner)
			if (!parsed.success) throw new Error(`Invalid Spawner adapter name: ${spawner}`)
			const installed = listSpawnerAdapters().some(adapter => adapter.available && adapter.name === parsed.data)
			if (!installed) throw new Error(`Spawner adapter not installed: ${parsed.data}`)
		}

		const common = {
			title: requiredOption(args, '--title'),
			projectSlug: requiredOption(args, '--project'),
			baseRef: optionValue(args, '--base-ref'),
			baseItemId: optionValue(args, '--base-item'),
			spawner,
			parallelism: positiveIntegerOption(args, '--parallelism'),
		}
		const commands = new ItemCommands(db.items, config)
		const items =
			kind === 'solve'
				? commands.createSolveItems({
						...common,
						prompt: requiredOption(args, '--prompt'),
					})
				: kind === 'ralph'
					? commands.createRalphItems({
							...common,
							prdPath: optionValueAny(args, ['--prd-path', '--prd']) ?? requiredOption(args, '--prd-path'),
							mode: enumOption(args, '--mode', ['once', 'afk'] as const),
							provider: enumOption(args, '--provider', ['claude', 'codex'] as const),
							model: optionValue(args, '--model'),
							effort: optionValue(args, '--effort'),
							iterations: positiveIntegerOption(args, '--iterations'),
							noOversee: args.includes('--no-oversee') ? true : undefined,
						})
					: commands.createHardenItems({
							...common,
							target: requiredOption(args, '--target'),
							rounds: positiveIntegerOption(args, '--rounds'),
						})

		const noun = items.length === 1 ? 'Item' : 'Items'
		console.log(`Created ${items.length} ${kind} ${noun}: ${items.map(item => item.id).join(', ')}`)
	} finally {
		db.close()
	}
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
