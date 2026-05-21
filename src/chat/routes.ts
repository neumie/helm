import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { VigilConfig } from '../config.js'
import type { DB } from '../db/client.js'
import type { ChatSession } from '../types.js'
import type { ChatChannel } from './channel.js'
import { verifyToken } from './token.js'

export function chatRoutes(config: VigilConfig, db: DB, channel: ChatChannel) {
	const app = new Hono()

	const getSecret = () => config.chat?.secret ?? ''

	function verifyTokenParam(token: string): ChatSession | null {
		const payload = verifyToken(token, getSecret())
		if (!payload) return null
		return db.getChatSessionByToken(token)
	}

	app.get('/sessions/by-token/:token', c => {
		const session = verifyTokenParam(c.req.param('token'))
		if (!session) return c.json({ error: 'Invalid or expired token' }, 401)

		const task = db.getTask(session.taskId)

		return c.json({
			session: {
				id: session.id,
				status: session.status,
				createdAt: session.createdAt,
				completedAt: session.completedAt,
			},
			task: task ? { title: task.title, projectSlug: task.projectSlug } : null,
		})
	})

	app.get('/sessions/by-token/:token/messages', c => {
		const session = verifyTokenParam(c.req.param('token'))
		if (!session) return c.json({ error: 'Invalid or expired token' }, 401)

		const messages = db.getChatMessages(session.id)
		return c.json({ messages })
	})

	app.post('/sessions/by-token/:token/messages', async c => {
		const session = verifyTokenParam(c.req.param('token'))
		if (!session) return c.json({ error: 'Invalid or expired token' }, 401)

		if (session.status !== 'active') {
			return c.json({ error: 'Chat session is not active' }, 400)
		}

		const body = await c.req.json<{ content: string }>()
		if (!body.content?.trim()) {
			return c.json({ error: 'Message content required' }, 400)
		}

		const messageId = channel.postUser(session.id, body.content.trim())

		return c.json({ messageId })
	})

	app.get('/sessions/by-token/:token/stream', c => {
		const session = verifyTokenParam(c.req.param('token'))
		if (!session) return c.json({ error: 'Invalid or expired token' }, 401)

		const sessionId = session.id

		return streamSSE(c, async stream => {
			const existing = db.getChatMessages(sessionId)
			await stream.writeSSE({ data: JSON.stringify({ type: 'init', messages: existing }), event: 'init' })

			let lastMessageCount = existing.length
			let done!: () => void
			const donePromise = new Promise<void>(resolve => {
				done = resolve
			})

			// Serialize async listener calls to prevent interleaved writeSSE
			let sending = false
			let queued = false

			const sendNewMessages = async () => {
				if (sending) {
					queued = true
					return
				}
				sending = true
				try {
					const messages = db.getChatMessages(sessionId)
					if (messages.length > lastMessageCount) {
						const newMessages = messages.slice(lastMessageCount)
						lastMessageCount = messages.length
						await stream.writeSSE({
							data: JSON.stringify({ type: 'messages', messages: newMessages }),
							event: 'messages',
						})
					}
					const currentSession = db.getChatSession(sessionId)
					if (currentSession?.status === 'completed') {
						await stream.writeSSE({
							data: JSON.stringify({ type: 'completed' }),
							event: 'completed',
						})
						done()
					}
				} catch {
					done()
				} finally {
					sending = false
					if (queued) {
						queued = false
						sendNewMessages()
					}
				}
			}

			const unsubscribe = channel.subscribe(sessionId, sendNewMessages)

			const heartbeat = setInterval(async () => {
				try {
					await stream.writeSSE({ data: '', event: 'heartbeat' })
				} catch {
					done()
					clearInterval(heartbeat)
				}
			}, 15000)

			try {
				await donePromise
			} finally {
				clearInterval(heartbeat)
				unsubscribe()
			}
		})
	})

	return app
}
