import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const LABEL = 'com.helm.daemon'
const PLIST_DIR = join(homedir(), 'Library', 'LaunchAgents')
const PLIST_PATH = join(PLIST_DIR, `${LABEL}.plist`)
// Legacy identity (vigil): migrated one-way on `helm start`.
const OLD_LABEL = 'com.vigil.daemon'
const OLD_PLIST_PATH = join(PLIST_DIR, `${OLD_LABEL}.plist`)
const LOG_DIR = join(homedir(), 'Library', 'Logs', 'helm')
export const STDOUT_LOG = join(LOG_DIR, 'stdout.log')
export const STDERR_LOG = join(LOG_DIR, 'stderr.log')

function helmRoot(): string {
	const thisFile = fileURLToPath(import.meta.url)
	// dist/cli/launchd.js -> project root (two levels up from dist/cli/)
	return resolve(dirname(thisFile), '..', '..')
}

function entryPoint(): string {
	return join(helmRoot(), 'dist', 'index.js')
}

function escapeXml(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * One-way migration from the legacy com.vigil.daemon launchd job: unload it
 * (ignoring errors — it may not be loaded), delete its plist, and remove any
 * registration that lingers WITHOUT a plist file (a hand-deleted plist leaves
 * the job loaded until `launchctl remove`) so only com.helm.daemon remains.
 */
function migrateLegacyLaunchdJob(): void {
	if (existsSync(OLD_PLIST_PATH)) {
		console.log(`Migrating legacy launchd job ${OLD_LABEL} -> ${LABEL} (unloading + removing old plist).`)
		try {
			execSync(`launchctl unload ${OLD_PLIST_PATH} 2>/dev/null`)
		} catch {
			// Old job wasn't loaded — fine, we only care that it's gone.
		}
		unlinkSync(OLD_PLIST_PATH)
	}

	// The legacy job can still be registered with launchd even when its plist
	// is gone (plist deleted by hand, or the unload above failed). Probe the
	// registration directly (exit 0 = registered) and remove it.
	try {
		execSync(`launchctl list ${OLD_LABEL} 2>/dev/null`)
	} catch {
		return // Exit != 0 — not registered; nothing left to migrate.
	}
	console.log(`Removing legacy launchd job ${OLD_LABEL} (still registered with launchd).`)
	try {
		execSync(`launchctl remove ${OLD_LABEL} 2>/dev/null`)
	} catch (err) {
		console.log(
			`Could not remove legacy launchd job ${OLD_LABEL} (ignored): ${err instanceof Error ? err.message : err}`,
		)
	}
}

function buildPlist(env: Record<string, string>): string {
	const root = escapeXml(helmRoot())
	const entry = escapeXml(entryPoint())
	const nodePath = escapeXml(process.execPath)
	const envEntries = Object.entries(env)
		.map(([k, v]) => `\t\t\t<key>${escapeXml(k)}</key>\n\t\t\t<string>${escapeXml(v)}</string>`)
		.join('\n')
	const envBlock =
		envEntries.length > 0 ? `\t<key>EnvironmentVariables</key>\n\t<dict>\n${envEntries}\n\t</dict>\n` : ''

	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${LABEL}</string>
\t<key>ProgramArguments</key>
\t<array>
\t\t<string>${nodePath}</string>
\t\t<string>${entry}</string>
\t</array>
\t<key>WorkingDirectory</key>
\t<string>${root}</string>
\t<key>KeepAlive</key>
\t<true/>
\t<key>StandardOutPath</key>
\t<string>${escapeXml(STDOUT_LOG)}</string>
\t<key>StandardErrorPath</key>
\t<string>${escapeXml(STDERR_LOG)}</string>
${envBlock}</dict>
</plist>`
}

export function isLoaded(): boolean {
	try {
		const output = execSync(`launchctl list ${LABEL} 2>/dev/null`, { encoding: 'utf-8' })
		return output.includes(LABEL)
	} catch {
		return false
	}
}

export function getPid(): number | null {
	try {
		const output = execSync(`launchctl list ${LABEL} 2>/dev/null`, { encoding: 'utf-8' })
		const match = output.match(/"PID"\s*=\s*(\d+)/)
		if (match) return Number(match[1])
		const lines = output.trim().split('\n')
		for (const line of lines) {
			const parts = line.trim().split('\t')
			if (parts[0] && /^\d+$/.test(parts[0])) return Number(parts[0])
		}
		return null
	} catch {
		return null
	}
}

export function load(): void {
	if (isLoaded()) {
		throw new Error('Helm is already running. Use `helm stop` first.')
	}

	if (!existsSync(entryPoint())) {
		throw new Error(`Compiled entry point not found at ${entryPoint()}. Run \`npm run build\` first.`)
	}

	migrateLegacyLaunchdJob()

	mkdirSync(LOG_DIR, { recursive: true })
	mkdirSync(PLIST_DIR, { recursive: true })

	const env: Record<string, string> = {}
	if (process.env.PATH) {
		env.PATH = process.env.PATH
	}
	// HELM_CONFIG preferred; VIGIL_CONFIG still honored (legacy compat).
	if (process.env.HELM_CONFIG) {
		env.HELM_CONFIG = process.env.HELM_CONFIG
	} else if (process.env.VIGIL_CONFIG) {
		env.VIGIL_CONFIG = process.env.VIGIL_CONFIG
	}

	writeFileSync(PLIST_PATH, buildPlist(env), 'utf-8')
	execSync(`launchctl load ${PLIST_PATH}`)
}

export function unload(): void {
	if (!isLoaded()) {
		throw new Error('Helm is not running.')
	}

	execSync(`launchctl unload ${PLIST_PATH}`)

	if (existsSync(PLIST_PATH)) {
		unlinkSync(PLIST_PATH)
	}
}
