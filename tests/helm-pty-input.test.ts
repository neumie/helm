import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import * as inputModule from '../app/src/pty-input.ts'
import type { HelmApi } from '../app/src/shared.ts'

const { encodePtyInput } = 'default' in inputModule ? (inputModule.default as typeof inputModule) : inputModule

test('PTY binary input retains exact eight-bit mouse bytes while typing stays UTF-8', () => {
	const packet = '\x1b[M\x60\xc8\x21'
	assert.deepEqual(encodePtyInput(packet, true), Buffer.from([27, 91, 77, 96, 200, 33]))
	assert.equal(encodePtyInput('Příliš 🐈'), 'Příliš 🐈')
	assert.equal(encodePtyInput(packet, false), packet)
	assert.equal(encodePtyInput(''), '')
})

test('PTY input rejects invalid transport flags and non-byte binary characters without truncation', () => {
	assert.equal(encodePtyInput('🐈', true), null)
	assert.equal(encodePtyInput('\u0100', true), null)
	assert.equal(encodePtyInput('\x1b[M', 'binary'), null)
	assert.equal(encodePtyInput(null), null)
})

test('production preload carries binary flag after unchanged profile token and preserves normal typing', () => {
	const sent: unknown[][] = []
	let api: HelmApi | undefined
	const source = readFileSync(new URL('../app/src/preload.ts', import.meta.url), 'utf8')
	const output = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	}).outputText
	runInNewContext(output, {
		exports: {},
		Buffer,
		process: { argv: [], env: {}, platform: 'darwin' },
		require(id: string) {
			assert.equal(id, 'electron')
			return {
				contextBridge: {
					exposeInMainWorld(name: string, value: HelmApi) {
						assert.equal(name, 'helm')
						api = value
					},
				},
				ipcRenderer: {
					sendSync: () => ({ daemonUrl: 'http://fixture.invalid', sessionProfileToken: 'profile:test' }),
					send: (...args: unknown[]) => sent.push(args),
				},
			}
		},
	})
	assert.ok(api)
	api.pty.write(7, '\x1b[M\x60\xc8\x21', true)
	api.pty.write(7, 'Příliš 🐈')
	assert.deepEqual(sent, [
		['pty:write', 7, '\x1b[M\x60\xc8\x21', 'profile:test', true],
		['pty:write', 7, 'Příliš 🐈', 'profile:test', undefined],
	])
	assert.deepEqual(encodePtyInput(sent[0]?.[2], sent[0]?.[4]), Buffer.from([27, 91, 77, 96, 200, 33]))
	assert.equal(encodePtyInput(sent[1]?.[2], sent[1]?.[4]), 'Příliš 🐈')
})
