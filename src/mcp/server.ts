import { randomUUID } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { z } from 'zod'
import type { ChatChannel } from '../chat/channel.js'
import { ClarificationChat } from '../chat/clarification.js'
import type { ChatLinks } from '../chat/links.js'
import type { VigilConfig } from '../config.js'
import type { DB } from '../db/client.js'
import type { TaskProvider } from '../providers/provider.js'

export function createMcpServer(
	config: VigilConfig,
	db: DB,
	provider: TaskProvider,
	chatLinks: ChatLinks,
	channel: ChatChannel,
) {
	const server = new McpServer({
		name: 'vigil',
		version: '0.1.0',
	})

	// The MCP tools are a thin adapter over the ClarificationChat module: they
	// translate tool args ↔ MCP content and own nothing of the chat orchestration.
	const chat = new ClarificationChat(config, db, provider, chatLinks, channel)

	server.tool(
		'vigil_create_chat',
		'Create a clarification chat session for a vague task. Returns a chat URL to share with the requester.',
		{
			taskId: z.string().describe('The Vigil task ID to create a chat for'),
			taskTitle: z.string().describe('The task title for context'),
			taskDescription: z.string().optional().describe('The task description if available'),
		},
		async ({ taskId, taskTitle, taskDescription }) => {
			if (!config.chat?.enabled) {
				return { content: [{ type: 'text', text: 'Chat is not enabled in Vigil config.' }], isError: true }
			}

			const { sessionId, chatUrl } = await chat.createInvite({ taskId, taskTitle, taskDescription })

			return {
				content: [{ type: 'text', text: JSON.stringify({ sessionId, chatUrl }) }],
			}
		},
	)

	server.tool(
		'vigil_send_message',
		'Send a message in a chat session and wait for the requester to respond. This call blocks until the requester replies.',
		{
			sessionId: z.string().describe('The chat session ID'),
			message: z.string().describe('The message to send to the requester'),
		},
		async ({ sessionId, message }) => {
			const outcome = await chat.sendAndAwaitReply(sessionId, message)
			switch (outcome.kind) {
				case 'reply':
					return { content: [{ type: 'text', text: `Requester responded: ${outcome.text}` }] }
				case 'inactive':
					return { content: [{ type: 'text', text: 'Chat session not found or not active.' }], isError: true }
				case 'closed':
					return {
						content: [{ type: 'text', text: 'Chat session was closed before a response was received.' }],
					}
				case 'timeout':
					return { content: [{ type: 'text', text: 'Timed out waiting for requester response.' }], isError: true }
			}
		},
	)

	server.tool(
		'vigil_end_chat',
		'End a chat session and get the full conversation transcript.',
		{
			sessionId: z.string().describe('The chat session ID to end'),
		},
		async ({ sessionId }) => {
			const transcript = chat.end(sessionId)
			if (transcript === null) {
				return { content: [{ type: 'text', text: 'Chat session not found.' }], isError: true }
			}

			return {
				content: [{ type: 'text', text: `Chat session ended. Transcript:\n\n${transcript}` }],
			}
		},
	)

	return server
}

const TRANSPORT_TTL_MS = 30 * 60 * 1000 // 30 minutes
const transports = new Map<string, { transport: WebStandardStreamableHTTPServerTransport; createdAt: number }>()

function createTransport(): WebStandardStreamableHTTPServerTransport {
	const transport = new WebStandardStreamableHTTPServerTransport({
		sessionIdGenerator: () => randomUUID(),
		onsessioninitialized: id => {
			transports.set(id, { transport, createdAt: Date.now() })
		},
	})
	return transport
}

// Periodic cleanup of stale transports
setInterval(
	() => {
		const now = Date.now()
		for (const [id, entry] of transports) {
			if (now - entry.createdAt > TRANSPORT_TTL_MS) {
				entry.transport.close()
				transports.delete(id)
			}
		}
	},
	5 * 60 * 1000,
)

export async function handleMcpRequest(server: McpServer, req: Request): Promise<Response> {
	const sessionId = req.headers.get('mcp-session-id')

	if (sessionId) {
		const entry = transports.get(sessionId)
		if (entry) {
			if (req.method === 'DELETE') {
				const response = await entry.transport.handleRequest(req)
				transports.delete(sessionId)
				return response
			}
			entry.createdAt = Date.now() // refresh TTL on activity
			return entry.transport.handleRequest(req)
		}
	}

	if (req.method === 'POST' || req.method === 'GET') {
		const transport = createTransport()
		await server.connect(transport)
		return transport.handleRequest(req)
	}

	return new Response('Session not found', { status: 404 })
}
