import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, rmdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Compile the complete fork + bridge against the EXACT CLI under test, without
// installing into or modifying either the user's Pi home or shared dependencies.
const cli = process.env.HELM_REMOTE_PROOF_PI
if (!cli) throw new Error('Set HELM_REMOTE_PROOF_PI to the installed Pi dist/cli.js')
const piRoot = resolve(dirname(cli), '..')
const version = JSON.parse(readFileSync(join(piRoot, 'package.json'), 'utf8')).version
if (version !== '0.85.1') throw new Error(`Unverified Pi version: ${version}; expected 0.85.1`)
const requirePi = createRequire(cli)
const root = fileURLToPath(new URL('..', import.meta.url))
const paths = { '@earendil-works/pi-coding-agent': [join(piRoot, 'dist/index.d.ts')] }
for (const name of ['pi-ai', 'pi-tui']) {
	const specifier = `@earendil-works/${name}`
	// pi-ai is import-only: CJS require.resolve intentionally cannot resolve its entry.
	const directory = requirePi.resolve
		.paths(specifier)
		?.map(base => join(base, specifier))
		.find(path => existsSync(join(path, 'package.json')))
	if (!directory) throw new Error(`Missing ${specifier} beside the selected CLI`)
	const metadata = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
	if (metadata.version !== version || typeof metadata.types !== 'string')
		throw new Error(`Mismatched ${specifier} types`)
	paths[specifier] = [join(directory, metadata.types)]
}
const scratch = mkdtempSync(join(tmpdir(), 'hr-types-'))
const path = join(scratch, 'tsconfig.json')
writeFileSync(
	path,
	JSON.stringify({
		extends: join(root, 'tsconfig.json'),
		compilerOptions: { noEmit: true, rootDir: root, baseUrl: root, paths },
		include: [
			join(root, 'packages/helm-remote-bridge/index.ts'),
			join(root, 'packages/helm-ask-user-question/index.ts'),
		],
	}),
)
try {
	const child = spawn(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', path], {
		stdio: 'inherit',
	})
	const code = await new Promise((resolve, reject) => {
		child.once('error', reject)
		child.once('exit', resolve)
	})
	if (code !== 0) process.exitCode = 1
	else console.log(`Complete questionnaire fork and bridge typechecked against Pi ${version}`)
} finally {
	rmSync(path)
	rmdirSync(scratch)
}
