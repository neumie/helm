// Records every existing (version 1) review control result as raw response bytes, with run-specific values
// replaced by stable placeholders. `tests/fixtures/document-review-wire-v1.json` was recorded with this helper
// against `main` before protocol 2 (helm open S1); the wire test replays it against the current host, so any byte
// change to an existing result fails. Run from another checkout: `recordWireTranscript('<that checkout>')`.
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import type * as CallerHelpers from './document-review-caller'

type CallerModule = typeof CallerHelpers

export interface WireStep {
	step: string
	frame: unknown
	response: string
}

function raw(socket: string, frame: unknown): Promise<string> {
	return new Promise((resolve, reject) => {
		const client = createConnection(socket)
		const chunks: Buffer[] = []
		client.once('connect', () => client.write(typeof frame === 'string' ? frame : `${JSON.stringify(frame)}\n`))
		client.on('data', chunk => chunks.push(chunk))
		client.once('error', reject)
		client.once('close', () => resolve(Buffer.concat(chunks).toString('utf8')))
	})
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g
const HEX = /\b[0-9a-f]{64}\b/g

/** Same placeholder for the same value everywhere in one transcript, numbered in order of first appearance. */
function normalizer(fixed: Record<string, string>) {
	const seen = new Map<string, string>()
	const name = (kind: string, value: string) => {
		let placeholder = seen.get(value)
		if (!placeholder) {
			placeholder = `<${kind}${[...seen.values()].filter(v => v.startsWith(`<${kind}`)).length + 1}>`
			seen.set(value, placeholder)
		}
		return placeholder
	}
	return (text: string) => {
		let result = text
		for (const [value, placeholder] of Object.entries(fixed)) result = result.split(value).join(placeholder)
		return result.replace(UUID, value => name('uuid', value)).replace(HEX, value => name('hex', value))
	}
}

export async function recordWireTranscript(base: string): Promise<WireStep[]> {
	const { callerFixture } = (await import(join(base, 'tests/helpers/document-review-caller.ts'))) as CallerModule
	const fixture = await callerFixture()
	const steps: WireStep[] = []
	try {
		const discovery = JSON.parse(await readFile(join(fixture.root, 'discovery.json'), 'utf8')) as {
			epoch: string
			socket: string
			token: string
		}
		const normalize = normalizer({ [fixture.workspace]: '<workspace>', [fixture.root]: '<root>' })
		const record = async (step: string, frame: unknown) => {
			const response = await raw(discovery.socket, frame)
			steps.push({
				step,
				frame: typeof frame === 'string' ? normalize(frame) : JSON.parse(normalize(JSON.stringify(frame))),
				response: normalize(response),
			})
			return response
		}
		const host = { epoch: discovery.epoch, token: discovery.token }
		await record('host status', { ...host, command: { action: 'status' } })
		const connected = JSON.parse(
			await record('connect', {
				...host,
				command: {
					action: 'connect',
					provider: 'pi',
					workspace: fixture.workspace,
					label: 'pi original caller',
					transport: 'tool-return',
				},
			}),
		).data as { connection: string; id: string; owner: string }
		const connection = JSON.parse(await readFile(connected.connection, 'utf8')) as { token: string }
		const bound = { epoch: discovery.epoch, token: connection.token, id: connected.id, owner: connected.owner }
		const opened = JSON.parse(await record('open', { ...bound, command: { action: 'open', file: fixture.file } }))
			.data as { documentId: string }
		await record('list', { ...bound, command: { action: 'list' } })
		await record('status', { ...bound, command: { action: 'status' } })
		await record('next (timeout)', { ...bound, command: { action: 'next', timeoutMs: 20 } })
		const requestId = randomUUID()
		const reading = record('next (feedback)', {
			...bound,
			command: { action: 'next', timeoutMs: 5000, documentId: opened.documentId },
		})
		for (let tries = 0; tries < 200 && !fixture.sessions.list(fixture.workspace)[0]?.listening; tries++)
			await new Promise(done => setTimeout(done, 5))
		fixture.send(connected, 'Discuss the actual source.', requestId)
		await reading
		await record('ack', { ...bound, command: { action: 'ack', requestId } })
		await record('reply (working)', {
			...bound,
			command: { action: 'reply', requestId, sequence: 1, state: 'working', text: 'Reading it.' },
		})
		await record('reply (complete)', {
			...bound,
			command: { action: 'reply', requestId, sequence: 2, state: 'complete', text: 'Done.' },
		})
		await record('receipt', { ...bound, command: { action: 'receipt', requestId } })
		await record('receipt (unknown)', { ...bound, command: { action: 'receipt', requestId: randomUUID() } })
		fixture.closeDocument()
		await record('next (window closed)', {
			...bound,
			command: { action: 'next', timeoutMs: 5000, documentId: opened.documentId },
		})
		await record('disconnect', { ...bound, command: { action: 'disconnect' } })
		await record('after disconnect', { ...bound, command: { action: 'status' } })
		await record('wrong epoch', { ...host, epoch: randomUUID(), command: { action: 'status' } })
		await record('wrong token', { ...host, token: 'f'.repeat(64), command: { action: 'status' } })
		await record('unbound command', { ...host, command: { action: 'list' } })
		await record('not JSON', 'not json\n')
		await record('two frames', `${JSON.stringify({ ...host, command: { action: 'status' } })}\n{}\n`)
	} finally {
		await fixture.close()
	}
	return steps
}
