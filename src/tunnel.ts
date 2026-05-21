import { spawn } from 'node:child_process'
import { log } from './util/logger.js'

interface TunnelResult {
	url: string
	stop: () => void
}

export function startTunnel(port: number): Promise<TunnelResult> {
	return new Promise((resolve, reject) => {
		const proc = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${port}`], {
			stdio: ['ignore', 'pipe', 'pipe'],
		})

		let resolved = false
		const timeout = setTimeout(() => {
			if (!resolved) {
				resolved = true
				reject(new Error('Timed out waiting for cloudflared tunnel URL'))
				proc.kill()
			}
		}, 30_000)

		const handleOutput = (data: Buffer) => {
			const text = data.toString()
			const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)
			if (match && !resolved) {
				resolved = true
				clearTimeout(timeout)
				const url = match[0]
				log.success('tunnel', `Public URL: ${url}`)
				resolve({
					url,
					stop: () => {
						proc.kill()
					},
				})
			}
		}

		proc.stdout.on('data', handleOutput)
		proc.stderr.on('data', handleOutput)

		proc.on('error', err => {
			if (!resolved) {
				resolved = true
				clearTimeout(timeout)
				reject(new Error(`Failed to start cloudflared: ${err.message}`))
			}
		})

		proc.on('exit', code => {
			if (!resolved) {
				resolved = true
				clearTimeout(timeout)
				reject(new Error(`cloudflared exited with code ${code}`))
			}
		})
	})
}
