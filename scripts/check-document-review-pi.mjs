import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Check the connector's real host API without installing resources or modifying Pi's settings/dependencies.
const cli = process.env.HELM_DOCUMENT_REVIEW_PI
if (!cli) throw new Error('Set HELM_DOCUMENT_REVIEW_PI to the installed Pi CLI JavaScript entrypoint')
let piRoot = dirname(resolve(cli))
while (!existsSync(join(piRoot, 'package.json'))) {
	const parent = dirname(piRoot)
	if (parent === piRoot) throw new Error('Cannot locate the selected Pi package')
	piRoot = parent
}
const metadata = JSON.parse(readFileSync(join(piRoot, 'package.json'), 'utf8'))
if (metadata.name !== '@earendil-works/pi-coding-agent' || !/^0\.99\./.test(metadata.version))
	throw new Error(
		`Unsupported connector typecheck target: ${metadata.name} ${metadata.version}; verify the new API explicitly`,
	)
const requirePi = createRequire(resolve(cli))
const root = fileURLToPath(new URL('..', import.meta.url))
const paths = { '@earendil-works/pi-coding-agent': [join(piRoot, metadata.types)] }
for (const name of ['@earendil-works/pi-ai', '@earendil-works/pi-tui', 'typebox']) {
	const directory = requirePi.resolve
		.paths(name)
		?.map(base => join(base, name))
		.find(path => existsSync(join(path, 'package.json')))
	if (!directory) throw new Error(`Missing host dependency ${name}`)
	const peer = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
	if (typeof peer.types !== 'string' || (name !== 'typebox' && peer.version !== metadata.version))
		throw new Error(`Mismatched ${name} types`)
	paths[name] = [join(directory, peer.types)]
}
const scratch = mkdtempSync(join(tmpdir(), 'hr-review-types-'))
const configuration = join(scratch, 'tsconfig.json')
writeFileSync(
	configuration,
	JSON.stringify({
		extends: join(root, 'tsconfig.json'),
		compilerOptions: { noEmit: true, rootDir: root, baseUrl: root, paths },
		include: [join(root, 'packages/helm-document-review/index.ts')],
	}),
)
try {
	const child = spawn(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', configuration], {
		stdio: 'inherit',
	})
	const code = await new Promise((resolve, reject) => {
		child.once('error', reject)
		child.once('exit', resolve)
	})
	if (code !== 0) process.exitCode = 1
	else console.log(`Complete existing-session Document Review connector typechecked against Pi ${metadata.version}`)
} finally {
	rmSync(scratch, { recursive: true, force: true })
}
