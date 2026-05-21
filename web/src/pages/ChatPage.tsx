import { useCallback, useEffect, useRef, useState } from 'react'

interface ChatMessage {
	id: string
	sessionId: string
	role: 'assistant' | 'user'
	content: string
	createdAt: string
}

interface SessionInfo {
	session: { id: string; status: 'active' | 'completed'; createdAt: string; completedAt: string | null }
	task: { title: string; projectSlug: string } | null
}

const CHAT_API = '/api/chat'

export function ChatPage({ token }: { token: string }) {
	const [messages, setMessages] = useState<ChatMessage[]>([])
	const [sessionInfo, setSessionInfo] = useState<SessionInfo | null>(null)
	const [input, setInput] = useState('')
	const [sending, setSending] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [completed, setCompleted] = useState(false)
	const messagesEndRef = useRef<HTMLDivElement>(null)
	const inputRef = useRef<HTMLInputElement>(null)

	// Load session info
	useEffect(() => {
		fetch(`${CHAT_API}/sessions/by-token/${token}`)
			.then(r => {
				if (!r.ok) throw new Error('Invalid or expired link')
				return r.json()
			})
			.then(data => {
				setSessionInfo(data)
				if (data.session.status === 'completed') setCompleted(true)
			})
			.catch(err => setError(err.message))
	}, [token])

	// SSE stream for real-time messages
	useEffect(() => {
		if (!sessionInfo || completed) return

		const eventSource = new EventSource(`${CHAT_API}/sessions/by-token/${token}/stream`)

		eventSource.addEventListener('init', (e: MessageEvent) => {
			const data = JSON.parse(e.data)
			if (data.messages) setMessages(data.messages)
		})

		eventSource.addEventListener('messages', (e: MessageEvent) => {
			const data = JSON.parse(e.data)
			if (data.messages) {
				setMessages(prev => {
					const existingIds = new Set(prev.map(m => m.id))
					const newMsgs = data.messages.filter((m: ChatMessage) => !existingIds.has(m.id))
					return [...prev, ...newMsgs]
				})
			}
		})

		eventSource.addEventListener('completed', () => {
			setCompleted(true)
			eventSource.close()
		})

		eventSource.onerror = () => {
			// SSE will auto-reconnect
		}

		return () => eventSource.close()
	}, [sessionInfo, token, completed])

	// Auto-scroll to bottom: messages is a trigger dep (re-run on each new message), not read in the body.
	// biome-ignore lint/correctness/useExhaustiveDependencies: messages drives the re-scroll intentionally
	useEffect(() => {
		messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
	}, [messages])

	// Focus input: messages is a trigger dep so the input re-focuses after each new message.
	// biome-ignore lint/correctness/useExhaustiveDependencies: messages intentionally re-triggers focus
	useEffect(() => {
		if (!completed) inputRef.current?.focus()
	}, [completed, messages])

	const sendMessage = useCallback(async () => {
		const text = input.trim()
		if (!text || sending || completed) return

		setSending(true)
		setInput('')

		try {
			const res = await fetch(`${CHAT_API}/sessions/by-token/${token}/messages`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ content: text }),
			})
			if (!res.ok) throw new Error('Failed to send message')
		} catch {
			setInput(text) // Restore input on failure
		} finally {
			setSending(false)
		}
	}, [input, sending, completed, token])

	if (error) {
		return (
			<div style={styles.container}>
				<div style={styles.errorCard}>
					<h2 style={{ margin: '0 0 8px' }}>Link expired or invalid</h2>
					<p style={{ margin: 0, color: '#666' }}>{error}</p>
				</div>
			</div>
		)
	}

	if (!sessionInfo) {
		return (
			<div style={styles.container}>
				<div style={styles.loading}>Loading...</div>
			</div>
		)
	}

	return (
		<div style={styles.container}>
			<div style={styles.chatWindow}>
				{/* Header */}
				<div style={styles.header}>
					<div style={styles.headerTitle}>{sessionInfo.task?.title ?? 'Task Clarification'}</div>
					<div style={styles.headerSub}>
						{completed ? 'Session complete — work is in progress' : 'Vigil needs more details'}
					</div>
				</div>

				{/* Messages */}
				<div style={styles.messageList}>
					{messages.length === 0 && !completed && (
						<div style={styles.waitingMessage}>Waiting for the first question...</div>
					)}
					{messages.map(msg => (
						<div
							key={msg.id}
							style={{
								...styles.bubble,
								...(msg.role === 'user' ? styles.userBubble : styles.assistantBubble),
							}}
						>
							<div style={styles.bubbleRole}>{msg.role === 'assistant' ? 'Vigil' : 'You'}</div>
							<div style={styles.bubbleContent}>{msg.content}</div>
						</div>
					))}
					{completed && <div style={styles.completedBanner}>Session complete. Work is in progress.</div>}
					<div ref={messagesEndRef} />
				</div>

				{/* Input */}
				{!completed && (
					<div style={styles.inputBar}>
						<input
							ref={inputRef}
							style={styles.input}
							type="text"
							placeholder="Type your answer..."
							value={input}
							onChange={e => setInput(e.target.value)}
							onKeyDown={e => {
								if (e.key === 'Enter' && !e.shiftKey) {
									e.preventDefault()
									sendMessage()
								}
							}}
							disabled={sending}
						/>
						<button
							type="button"
							style={{
								...styles.sendButton,
								opacity: sending || !input.trim() ? 0.5 : 1,
							}}
							onClick={sendMessage}
							disabled={sending || !input.trim()}
						>
							Send
						</button>
					</div>
				)}
			</div>
		</div>
	)
}

const styles: Record<string, React.CSSProperties> = {
	container: {
		display: 'flex',
		justifyContent: 'center',
		alignItems: 'center',
		minHeight: '100vh',
		background: '#f0f0f0',
		padding: '16px',
		fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
	},
	chatWindow: {
		width: '100%',
		maxWidth: '600px',
		height: '80vh',
		maxHeight: '800px',
		background: '#fff',
		borderRadius: '12px',
		boxShadow: '0 2px 12px rgba(0,0,0,0.1)',
		display: 'flex',
		flexDirection: 'column',
		overflow: 'hidden',
	},
	header: {
		padding: '16px 20px',
		borderBottom: '1px solid #e5e5e5',
		background: '#fafafa',
	},
	headerTitle: {
		fontSize: '16px',
		fontWeight: 600,
		color: '#111',
	},
	headerSub: {
		fontSize: '13px',
		color: '#666',
		marginTop: '4px',
	},
	messageList: {
		flex: 1,
		overflow: 'auto',
		padding: '16px 20px',
		display: 'flex',
		flexDirection: 'column',
		gap: '12px',
	},
	bubble: {
		maxWidth: '80%',
		padding: '10px 14px',
		borderRadius: '12px',
		fontSize: '14px',
		lineHeight: '1.5',
	},
	assistantBubble: {
		alignSelf: 'flex-start',
		background: '#f0f0f0',
		borderBottomLeftRadius: '4px',
	},
	userBubble: {
		alignSelf: 'flex-end',
		background: '#0066ff',
		color: '#fff',
		borderBottomRightRadius: '4px',
	},
	bubbleRole: {
		fontSize: '11px',
		fontWeight: 600,
		marginBottom: '4px',
		opacity: 0.7,
	},
	bubbleContent: {
		whiteSpace: 'pre-wrap',
		wordBreak: 'break-word',
	},
	inputBar: {
		display: 'flex',
		gap: '8px',
		padding: '12px 16px',
		borderTop: '1px solid #e5e5e5',
		background: '#fafafa',
	},
	input: {
		flex: 1,
		padding: '10px 14px',
		border: '1px solid #ddd',
		borderRadius: '8px',
		fontSize: '14px',
		outline: 'none',
	},
	sendButton: {
		padding: '10px 20px',
		background: '#0066ff',
		color: '#fff',
		border: 'none',
		borderRadius: '8px',
		fontSize: '14px',
		fontWeight: 600,
		cursor: 'pointer',
	},
	waitingMessage: {
		textAlign: 'center',
		color: '#999',
		padding: '40px 0',
		fontSize: '14px',
	},
	completedBanner: {
		textAlign: 'center',
		padding: '12px',
		background: '#e8f5e9',
		color: '#2e7d32',
		borderRadius: '8px',
		fontSize: '14px',
		fontWeight: 500,
	},
	errorCard: {
		background: '#fff',
		padding: '32px',
		borderRadius: '12px',
		boxShadow: '0 2px 12px rgba(0,0,0,0.1)',
		textAlign: 'center',
	},
	loading: {
		color: '#999',
		fontSize: '16px',
	},
}
