// macOS Keychain access for the Slack session: reading the "Slack Safe Storage" password (the
// user's consent prompt) and reading/writing/deleting Helm's own copy of the session. Secrets are
// passed on the `security` tool's stdin (never argv) and are never logged. All methods are injected
// as a `KeychainAccess` seam so the daemon/CLI code is testable without the real Keychain.

import { spawn } from 'node:child_process'

/** Helm's own Keychain service for stored Slack sessions. */
export const HELM_SLACK_SERVICE = 'helm.slack'
/** The account under HELM_SLACK_SERVICE that lists connected team ids (JSON array). */
export const HELM_SLACK_INDEX_ACCOUNT = 'index'
/** Slack.app's Chromium Safe Storage item. */
export const SLACK_SAFE_STORAGE_SERVICE = 'Slack Safe Storage'

export interface KeychainAccess {
	/** Read a generic-password value, or null when the item is absent. Reading may prompt the user. */
	read(service: string, account: string): Promise<string | null>
	/** Create or replace a generic-password value (via stdin, never argv). */
	write(service: string, account: string, value: string): Promise<void>
	/** Remove an item; a no-op when it is absent. */
	remove(service: string, account: string): Promise<void>
}

interface RunResult {
	code: number
	stdout: string
	stderr: string
}

/** Quote a `security -i` command argument (service/account names, never a secret). */
function shellArg(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`
}

function run(args: string[], stdin?: string): Promise<RunResult> {
	return new Promise((resolve, reject) => {
		const child = spawn('/usr/bin/security', args, { stdio: ['pipe', 'pipe', 'pipe'] })
		let stdout = ''
		let stderr = ''
		child.stdout.on('data', chunk => {
			stdout += chunk
		})
		child.stderr.on('data', chunk => {
			stderr += chunk
		})
		child.on('error', reject)
		child.on('close', code => resolve({ code: code ?? -1, stdout, stderr }))
		if (stdin !== undefined) {
			child.stdin.write(stdin)
		}
		child.stdin.end()
	})
}

/** The real macOS Keychain. Secrets go through stdin or `-w` stdout, never argv or logs. */
export const macKeychain: KeychainAccess = {
	async read(service, account) {
		const result = await run(['find-generic-password', '-s', service, '-a', account, '-w'])
		if (result.code !== 0) return null
		// `-w` prints the value plus a trailing newline.
		return result.stdout.replace(/\n$/, '')
	},
	async write(service, account, value) {
		// Keep the value off every process's argv: `security -i` runs commands read from stdin, so the
		// value rides on stdin, not the command line (invisible to `ps`). The value must be a single
		// whitespace-free token (callers store base64); reject anything else so it cannot break the
		// interactive command line.
		if (/\s/.test(value)) throw new Error('Keychain values must be whitespace-free (base64)')
		const command = `add-generic-password -U -s ${shellArg(service)} -a ${shellArg(account)} -w ${value}\n`
		const result = await run(['-i'], command)
		if (result.code !== 0) {
			throw new Error(`Keychain write failed for ${service}/${account}: ${result.stderr.trim() || result.code}`)
		}
	},
	async remove(service, account) {
		const result = await run(['delete-generic-password', '-s', service, '-a', account])
		// 44 = item not found; treat as already removed.
		if (result.code !== 0 && result.code !== 44) {
			throw new Error(`Keychain delete failed for ${service}/${account}: ${result.stderr.trim() || result.code}`)
		}
	},
}

/** Read the Slack Safe Storage password (prompts the user on first access). */
export async function readSafeStoragePassword(keychain: KeychainAccess): Promise<string | null> {
	// The account label Slack writes; fall back to any account under the service.
	return keychain.read(SLACK_SAFE_STORAGE_SERVICE, 'Slack App Store Key')
}
