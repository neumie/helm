import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { launchWorkspace } from './workspace-launcher.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const app = fileURLToPath(new URL('../app/', import.meta.url))
const controller = new AbortController()
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => controller.abort(signal))

async function run(command, args, cwd) {
	controller.signal.throwIfAborted()
	await new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd, stdio: 'inherit', signal: controller.signal, shell: false })
		child.once('error', reject)
		child.once('exit', (code, signal) =>
			code === 0 ? resolve() : reject(new Error(`Build/start preparation failed (${code ?? signal})`)),
		)
	})
}

try {
	// Build once before either runtime is admitted. app/build also compiles the daemon/Remote code.
	await run('bun', ['run', 'build'], app)
	await run(process.execPath, ['app/scripts/build-remote.mjs'], root)
	await run('bun', ['run', 'brand-electron'], app)
	const requireApp = createRequire(new URL('../app/package.json', import.meta.url))
	const workspace = await launchWorkspace({
		remote: { command: process.execPath, args: ['dist/remote/runtime.js'], cwd: root },
		desktop: { command: requireApp('electron'), args: [app, ...process.argv.slice(2)], cwd: app },
		signal: controller.signal,
	})
	const results = await workspace.finished
	process.exitCode = controller.signal.aborted ? 0 : results.some(result => result.code !== 0) ? 1 : 0
} catch (error) {
	if (!controller.signal.aborted) {
		console.error(error instanceof Error ? error.message : 'Helm startup failed')
		process.exitCode = 1
	}
}
