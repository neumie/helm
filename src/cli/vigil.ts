#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { STDERR_LOG, STDOUT_LOG, getPid, isLoaded, load, unload } from './launchd.js'

const HELP = `Usage: vigil <command>

Commands:
  start           Start the Vigil daemon
  stop            Stop the Vigil daemon
  status          Show daemon status
  logs            Tail daemon logs (--err for stderr)
  run             Run a single task and exit
  install-skills  Install bundled vigil-* skills into ~/.claude and ~/.agents
  help            Show this help message`

const INSTALL_SKILLS_HELP = `Usage: vigil install-skills [--claude] [--codex]

Install bundled vigil-* skills into the user's global skill dirs so they're
available in your own Claude Code / Codex CLI sessions (planner-side).

Destinations:
  --claude        ~/.claude/skills/vigil/<skill>
  --codex         ~/.agents/skills/vigil/<skill>

With no flags, installs both targets.`

const RUN_HELP = `Usage: vigil run <id> [--project <slug>]

Run a single task by its Vigil task ID or external (clientcare) ID.

Arguments:
  <id>                 Vigil task ID (UUID) or external clientcare ID

Options:
  --project <slug>     Project slug (required when creating a new task)`

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

async function run(): Promise<void> {
	const args = process.argv.slice(3)
	const id = args.find(a => !a.startsWith('--'))
	if (!id || args.includes('--help') || args.includes('-h')) {
		console.log(RUN_HELP)
		process.exit(id ? 0 : 1)
	}

	const projectIdx = args.indexOf('--project')
	const projectSlug = projectIdx !== -1 ? args[projectIdx + 1] : undefined

	const { loadConfig } = await import('../config.js')
	const { DB } = await import('../db/client.js')
	const { createProvider } = await import('../providers/registry.js')
	const { DefaultSolver } = await import('../solver/default-solver.js')
	const { processTask } = await import('../queue/worker.js')

	const { config } = loadConfig()
	const db = new DB()
	const provider = createProvider(config.provider)

	let solver: import('../solver/solver.js').Solver
	if (config.solver.type === 'okena') {
		try {
			const { createOkenaSolver } = await import('../extensions/okena/solver.js')
			solver = await createOkenaSolver(config)
		} catch {
			solver = new DefaultSolver(config)
		}
	} else {
		solver = new DefaultSolver(config)
	}

	// Look up task: first by task ID, then by clientcare ID
	let task = db.getTask(id) ?? db.getTaskByClientcareId(id)

	if (task) {
		console.log(`Found existing task: ${task.title} [${task.status}]`)
		db.updateTask(task.id, { status: 'queued', startedAt: null, completedAt: null, errorMessage: null, errorPhase: null })
	} else {
		// Create new task from external ID
		if (!projectSlug) {
			console.error('Task not found in DB. Use --project <slug> to create it from the external source.')
			process.exit(1)
		}
		if (!config.projects.find(p => p.slug === projectSlug)) {
			console.error(`Unknown project slug: ${projectSlug}`)
			process.exit(1)
		}
		const taskId = randomUUID()
		const context = await provider.getTaskContext(id)
		if (!context) {
			console.error(`Task not found in source system: ${id}`)
			process.exit(1)
		}
		db.insertTask({ id: taskId, clientcareId: id, projectSlug, title: context.title })
		db.insertEvent(taskId, 'task_discovered', { source: 'cli' })
		task = db.getTask(taskId)!
		console.log(`Created task: ${task.title}`)
	}

	console.log(`Processing task ${task.id}...`)
	await processTask(task.id, config, db, provider, solver)

	const result = db.getTask(task.id)!
	console.log(`\nResult: ${result.status}${result.tier ? ` (${result.tier})` : ''}`)
	if (result.solverSummary) console.log(`Summary: ${result.solverSummary}`)
	if (result.prUrl) console.log(`PR: ${result.prUrl}`)
	if (result.errorMessage) console.log(`Error: ${result.errorMessage}`)

	db.close()
	process.exit(result.status === 'completed' ? 0 : 1)
}

async function installSkills(): Promise<void> {
	const args = process.argv.slice(3)
	if (args.includes('--help') || args.includes('-h')) {
		console.log(INSTALL_SKILLS_HELP)
		process.exit(0)
	}

	const wantClaude = args.includes('--claude')
	const wantCodex = args.includes('--codex')
	// Default: install both if no flags given
	const targets: Array<'claude' | 'codex'> = (() => {
		if (!wantClaude && !wantCodex) return ['claude', 'codex']
		const out: Array<'claude' | 'codex'> = []
		if (wantClaude) out.push('claude')
		if (wantCodex) out.push('codex')
		return out
	})()

	const { installSkillsGlobally } = await import('../skills/installer.js')
	const { homedir } = await import('node:os')
	const { join } = await import('node:path')

	for (const target of targets) {
		installSkillsGlobally(target)
		const base = target === 'claude' ? '.claude/skills/vigil' : '.agents/skills/vigil'
		console.log(`Installed ${target} skills at ${join(homedir(), base)}`)
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
	case 'run':
		run().catch(err => {
			console.error(`Error: ${err instanceof Error ? err.message : err}`)
			process.exit(1)
		})
		break
	case 'install-skills':
		installSkills().catch(err => {
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
