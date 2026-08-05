import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { type Server, createServer } from 'node:http'
import { join } from 'node:path'
import test from 'node:test'
import { configSchema } from '../src/config.js'
import { HoldKnowledgeProvider } from '../src/knowledge/hold-provider.js'

const PROJECT_ID = 'prj_test_project'
const CAPABILITY_ID = 'cap_test_client'
const SECRET = Buffer.alloc(32, 7).toString('base64url')
const TOKEN = `${CAPABILITY_ID}.${SECRET}`
const CONTEXT = '# Accepted knowledge\n\nSigned handoffs require a checksum.'

function sha256(value: string) {
	return createHash('sha256').update(value).digest('hex')
}

interface Harness {
	root: string
	socketPath: string
	capabilityFile: string
	server: Server
	requests: Array<{ path: string; body: unknown; authorization: string | undefined }>
	mode: { noStore: boolean; malformedHash: boolean; hangBrief: boolean; scopedProjects: string[]; token: string }
	provider: HoldKnowledgeProvider
	close(): Promise<void>
}

async function harness(): Promise<Harness> {
	const root = mkdtempSync(join(process.cwd(), '.hold-provider-test-'))
	chmodSync(root, 0o700)
	const socketPath = join(root, 'hold.sock')
	const capabilityFile = join(root, 'hold.capability')
	writeFileSync(capabilityFile, TOKEN, { mode: 0o600 })
	const requests: Harness['requests'] = []
	const mode: Harness['mode'] = {
		noStore: true,
		malformedHash: false,
		hangBrief: false,
		scopedProjects: [PROJECT_ID],
		token: TOKEN,
	}
	const server = createServer((request, response) => {
		const chunks: Buffer[] = []
		request.on('data', chunk => chunks.push(Buffer.from(chunk)))
		request.on('end', () => {
			const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
			requests.push({ path: request.url ?? '', body, authorization: request.headers.authorization })
			response.setHeader('content-type', 'application/json')
			if (mode.noStore) response.setHeader('cache-control', 'no-store, max-age=0')
			if (request.headers.authorization !== `Bearer ${mode.token}`) {
				response.statusCode = 401
				response.end(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'denied' } }))
				return
			}
			if (request.url === '/v1/handshake') {
				response.end(
					JSON.stringify({
						protocolVersion: 1,
						capabilityId: CAPABILITY_ID,
						operations: ['brief:prepare', 'candidates:submit'],
						projectIds: mode.scopedProjects,
						limits: {
							briefCharacters: 200_000,
							candidateBatchItems: 20,
							candidateContentCharacters: 20_000,
						},
					}),
				)
				return
			}
			if (request.url?.endsWith('/brief')) {
				if (mode.hangBrief) return
				response.end(
					JSON.stringify({
						context: CONTEXT,
						selectionId: sha256('selection'),
						generation: 4,
						catalogRevision: sha256('catalog'),
						createdAt: '2030-05-06T07:08:09.000Z',
						hash: mode.malformedHash ? sha256('wrong') : sha256(CONTEXT),
						manifest: [
							{
								sourceId: 'wiki_source',
								role: 'foundational',
								relativePath: 'overview.md',
								contentHash: sha256(CONTEXT),
								sourceHash: sha256('complete source'),
								characterCount: [...CONTEXT].length,
								start: 0,
								end: CONTEXT.length,
							},
						],
					}),
				)
				return
			}
			if (request.url?.endsWith('/candidates')) {
				response.statusCode = 202
				response.end(
					JSON.stringify({
						receiptId: 'receipt-1',
						candidateIds: ['candidate-1'],
						recordId: 'record-1',
						jobId: 'job-1',
						idempotentReplay: false,
						createdAt: '2030-05-06T07:08:09.000Z',
					}),
				)
				return
			}
			response.statusCode = 404
			response.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'missing' } }))
		})
	})
	await new Promise<void>((resolveListen, rejectListen) => {
		server.once('error', rejectListen)
		server.listen(socketPath, resolveListen)
	})
	chmodSync(socketPath, 0o600)
	const config = configSchema.parse({
		provider: {
			type: 'contember',
			apiBaseUrl: 'https://example.test',
			projectSlug: 'test',
			apiToken: 'test',
		},
		projects: [{ slug: 'sample', repoPath: root, baseBranch: 'main' }],
		knowledge: {
			providers: [
				{
					id: 'local-hold',
					type: 'hold',
					socketPath,
					capabilityFile,
					timeouts: { handshakeMs: 500, briefMs: 500, candidatesMs: 500 },
				},
			],
		},
	})
	const providerConfig = config.knowledge?.providers[0]
	assert.ok(providerConfig)
	const provider = new HoldKnowledgeProvider(providerConfig)
	return {
		root,
		socketPath,
		capabilityFile,
		server,
		requests,
		mode,
		provider,
		async close() {
			await new Promise<void>(resolveClose => server.close(() => resolveClose()))
			rmSync(root, { recursive: true, force: true })
		},
	}
}

test('Hold adapter handshakes, maps exact briefs, and submits typed candidates', async () => {
	const env = await harness()
	try {
		const brief = await env.provider.prepareBrief({
			providerProjectId: PROJECT_ID,
			purpose: 'solve',
			query: 'handoff',
			characterBudget: 20_000,
		})
		assert.equal(brief.context, CONTEXT)
		assert.equal(brief.contextHash, sha256(CONTEXT))
		assert.equal(brief.sources[0].range.unit, 'utf16-code-units')

		const receipt = await env.provider.submitCandidates({
			providerProjectId: PROJECT_ID,
			idempotencyKey: sha256('candidate-batch'),
			attemptRef: 'helm-outbox:test',
			sourceRefs: ['item-1', 'snapshot-1'],
			candidates: [{ type: 'decision', title: 'Checksum', content: 'Use a checksum.' }],
		})
		assert.equal(receipt.receiptRef, 'receipt-1')
		assert.equal(receipt.candidateRefs.length, 1)
		assert.equal(env.requests.filter(request => request.path === '/v1/handshake').length, 1)
		const submission = env.requests.find(request => request.path.endsWith('/candidates'))?.body as {
			candidates: Array<{ type: string; content: string; provenance: { attemptId: string } }>
		}
		assert.equal(submission.candidates[0].type, 'decision')
		assert.match(submission.candidates[0].content, /^# Checksum/)
		assert.equal(submission.candidates[0].provenance.attemptId, 'helm-outbox:test')
	} finally {
		await env.close()
	}
})

test('Hold adapter fails closed for scope, integrity, headers, timeout, and unsafe credentials', async () => {
	const env = await harness()
	try {
		env.mode.scopedProjects = []
		await assert.rejects(
			env.provider.prepareBrief({
				providerProjectId: PROJECT_ID,
				purpose: 'planning',
				query: 'scope',
				characterBudget: 1_000,
			}),
			{ code: 'scope' },
		)

		const freshForIntegrity = new HoldKnowledgeProvider({
			id: 'integrity',
			type: 'hold',
			socketPath: env.socketPath,
			capabilityFile: env.capabilityFile,
			timeouts: { handshakeMs: 500, briefMs: 500, candidatesMs: 500 },
		})
		env.mode.scopedProjects = [PROJECT_ID]
		env.mode.malformedHash = true
		await assert.rejects(
			freshForIntegrity.prepareBrief({
				providerProjectId: PROJECT_ID,
				purpose: 'solve',
				query: 'integrity',
				characterBudget: 1_000,
			}),
			{ code: 'invalid-response' },
		)

		env.mode.malformedHash = false
		env.mode.noStore = false
		const noStore = new HoldKnowledgeProvider({
			id: 'headers',
			type: 'hold',
			socketPath: env.socketPath,
			capabilityFile: env.capabilityFile,
			timeouts: { handshakeMs: 500, briefMs: 500, candidatesMs: 500 },
		})
		await assert.rejects(
			noStore.prepareBrief({
				providerProjectId: PROJECT_ID,
				purpose: 'solve',
				query: 'headers',
				characterBudget: 1_000,
			}),
			{ code: 'invalid-response' },
		)

		env.mode.noStore = true
		env.mode.hangBrief = true
		const timeout = new HoldKnowledgeProvider({
			id: 'timeout',
			type: 'hold',
			socketPath: env.socketPath,
			capabilityFile: env.capabilityFile,
			timeouts: { handshakeMs: 500, briefMs: 100, candidatesMs: 500 },
		})
		await assert.rejects(
			timeout.prepareBrief({
				providerProjectId: PROJECT_ID,
				purpose: 'solve',
				query: 'timeout',
				characterBudget: 1_000,
			}),
			{ code: 'timeout' },
		)

		chmodSync(env.capabilityFile, 0o644)
		await assert.rejects(
			env.provider.submitCandidates({
				providerProjectId: PROJECT_ID,
				idempotencyKey: sha256('unsafe-file'),
				attemptRef: 'attempt',
				sourceRefs: [],
				candidates: [{ type: 'lesson', title: 'Safe', content: 'Safe content.' }],
			}),
			{ code: 'configuration' },
		)
	} finally {
		await env.close()
	}
})
