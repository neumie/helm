// `helm slack`: connect Helm to the session Slack.app already holds, then let an agent read a DM /
// thread and send messages. Talks DIRECTLY to Slack with the session from Helm's Keychain (never
// the daemon for Slack calls); reads the daemon only for the send guard and `--signal` lookups.
// No token or cookie is ever printed, logged or put on an argv; `connect` triggers Jakub's macOS
// Keychain prompt (his consent). `send` is guarded to Jakub's own DM unless signals.slack.agentSendTo
// allows the target, and HELM_SLACK_SEND_SELF_ONLY=1 forces self-only.

import { readFileSync } from 'node:fs'
import { oneLine } from '../agent-dock/text.js'
import { SlackActions } from '../signals/slack-actions.js'
import { slackMrkdwnToPlain, slackTsToIso } from '../signals/slack-map.js'
import { type SlackSession, SlackSessionStore, readSlackAppSessions, sessionInfo } from '../slack/session.js'
import { SlackClient } from '../slack/web-api.js'
import type { SlackAuthTest, SlackMessage, SlackRepliesResponse, SlackUser } from '../slack/web-types.js'
import { DEFAULT_DAEMON_URL, type DaemonMethod, daemonBaseUrl, requestDaemon } from './daemon-http.js'

export const SLACK_HELP = `Usage: helm slack <command> [options]

Connect Helm to the Slack session the Slack app already holds (no Slack app to
create), then read and send. Secrets stay in the macOS Keychain; connecting
prompts you to allow it.

Commands:
  connect            Read Slack.app's session (you approve the Keychain prompt)
                     and store it in Helm's own Keychain. Lists the workspaces.
  disconnect         Remove Helm's stored session (--team T for one workspace)
  status             Connected workspaces and who you are (never the token)
  user <q>           Resolve a Slack user: @handle, U..., or an email
  read <target>      Print a DM or thread (untrusted text): #channel, a channel/
                     DM id, @handle, U..., an email, or --signal ID
  send --to <target> Post a message (--text or --text-file). Only to yourself
                     unless signals.slack.agentSendTo allows the target.

Options:
  --team T           Workspace (team id or domain) when several are connected
  --thread TS        Reply in this thread (send/read)
  --signal ID        Use the Slack thread of Signals row ID (read/send)
  --text "…"         Message text (send)
  --text-file F      Read the text from file F, or - for stdin (send)
  --limit N          How many messages to print (read; default 20)
  --json             Machine-readable output
  --url <baseUrl>    Daemon base URL (default: $HELM_URL or http://localhost:7474)
`

interface Flags {
	team?: string
	thread?: string
	signal?: number
	text?: string
	textFile?: string
	limit?: number
	json: boolean
	url?: string
	rest: string[]
}

function parseFlags(args: string[]): Flags {
	const flags: Flags = { json: false, rest: [] }
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]
		const next = () => args[++i]
		switch (arg) {
			case '--team':
				flags.team = next()
				break
			case '--thread':
				flags.thread = next()
				break
			case '--signal':
				flags.signal = Number(next())
				break
			case '--text':
				flags.text = next()
				break
			case '--text-file':
				flags.textFile = next()
				break
			case '--limit':
				flags.limit = Number(next())
				break
			case '--url':
				flags.url = next()
				break
			case '--json':
				flags.json = true
				break
			default:
				if (arg !== undefined) flags.rest.push(arg)
		}
	}
	return flags
}

function out(json: boolean, human: string, data: unknown): void {
	console.log(json ? JSON.stringify(data) : human)
}

function fail(message: string): never {
	console.error(message)
	process.exit(1)
}

async function readText(flags: Flags): Promise<string> {
	if (flags.text !== undefined) return flags.text
	if (flags.textFile === undefined) fail('Give --text or --text-file')
	if (flags.textFile === '-') return readFileSync(0, 'utf8')
	return readFileSync(flags.textFile, 'utf8')
}

/** The daemon's dashboard-safe config value at a path, or undefined when unreachable. */
async function daemonConfig<T>(baseUrl: string, path: string[]): Promise<T | undefined> {
	try {
		const config = await requestDaemon<Record<string, unknown>>('GET' as DaemonMethod, baseUrl, '/api/config')
		let node: unknown = config
		for (const key of path) node = node && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined
		return node as T
	} catch {
		return undefined
	}
}

export async function runSlackProcess(args: string[]): Promise<void> {
	const command = args[0]
	const flags = parseFlags(args.slice(1))
	const store = new SlackSessionStore()

	if (command === 'help' || command === '--help' || command === '-h' || command === undefined) {
		console.log(SLACK_HELP)
		return
	}

	if (command === 'connect') {
		let sessions: SlackSession[]
		try {
			sessions = await readSlackAppSessions()
		} catch (error) {
			fail(`Could not read the Slack session: ${error instanceof Error ? error.message : error}`)
		}
		const verified: SlackSession[] = []
		const report: { team: string; user: string; ok: boolean }[] = []
		for (const session of sessions) {
			try {
				const auth = await new SlackClient({ token: session.token, cookie: session.cookie }).call<SlackAuthTest>(
					'auth.test',
				)
				verified.push({ ...session, userId: auth.user_id ?? session.userId })
				report.push({ team: session.name, user: auth.user ?? session.userId, ok: true })
			} catch {
				report.push({ team: session.name, user: session.userId, ok: false })
			}
		}
		if (verified.length > 0) await store.save(verified)
		out(
			flags.json,
			report.map(r => `${r.ok ? '✓' : '✗'} ${r.team}${r.ok ? ` (${r.user})` : ' — not verified'}`).join('\n') ||
				'No workspaces found',
			report,
		)
		return
	}

	if (command === 'disconnect') {
		await store.remove(flags.team)
		out(flags.json, flags.team ? `Disconnected ${flags.team}` : 'Disconnected every workspace', { ok: true })
		return
	}

	if (command === 'status') {
		const ids = await store.list()
		const rows: { team: string; domain: string; user: string; ok: boolean }[] = []
		for (const id of ids) {
			const session = await store.get(id)
			if (!session) continue
			try {
				const auth = await new SlackClient({ token: session.token, cookie: session.cookie }).call<SlackAuthTest>(
					'auth.test',
				)
				rows.push({ team: session.name, domain: session.domain, user: auth.user ?? session.userId, ok: true })
			} catch {
				rows.push({ team: session.name, domain: session.domain, user: session.userId, ok: false })
			}
		}
		if (rows.length === 0) {
			out(flags.json, 'Not connected. Run: helm slack connect', { connected: [] })
			return
		}
		out(
			flags.json,
			rows
				.map(
					r => `${r.ok ? '✓' : '✗'} ${r.team} (${r.domain})${r.ok ? ` — ${r.user}` : ' — session expired, reconnect'}`,
				)
				.join('\n'),
			{ connected: rows.map(r => sessionInfoLike(r)) },
		)
		return
	}

	const actions = new SlackActions({ store })

	if (command === 'user') {
		const query = flags.rest[0]
		if (!query) fail('Give a user: @handle, U…, or an email')
		const user = await actions.resolveUser(flags.team, query)
		if (!user) fail('User not found')
		out(flags.json, `${userName(user)} (${user.id})`, user)
		return
	}

	if (command === 'read') {
		await runRead(actions, store, flags)
		return
	}

	if (command === 'send') {
		await runSend(actions, store, flags)
		return
	}

	fail(`Unknown command: ${command}\n\n${SLACK_HELP}`)
}

function sessionInfoLike(r: { team: string; domain: string; user: string }): {
	name: string
	domain: string
	user: string
} {
	return { name: r.team, domain: r.domain, user: r.user }
}

function userName(user: SlackUser): string {
	return user.profile?.display_name || user.real_name || user.name || user.id || 'unknown'
}

/** Resolve a `read`/`send` target to a channel id (+ optional thread) via the daemon or Slack. */
async function resolveTarget(
	actions: SlackActions,
	flags: Flags,
	baseUrl: string,
): Promise<{ teamId?: string; channel?: string; user?: string; threadTs?: string }> {
	if (flags.signal !== undefined && Number.isSafeInteger(flags.signal)) {
		const thread = await requestDaemon<{ threadKey?: string }>(
			'GET' as DaemonMethod,
			baseUrl,
			`/api/signals/${flags.signal}`,
		)
		const parts = (thread.threadKey ?? '').split(':')
		if (parts[0] !== 'slack') fail('That signal is not a Slack thread')
		return { teamId: parts[1], channel: parts[2], threadTs: parts[3] ?? flags.thread }
	}
	const target = flags.rest[0] ?? (flags.text !== undefined || flags.textFile !== undefined ? undefined : undefined)
	const to = flags.rest[0]
	if (!to) return { teamId: flags.team, threadTs: flags.thread }
	void target
	if (/^[CGD][A-Z0-9]+$/i.test(to)) return { teamId: flags.team, channel: to, threadTs: flags.thread }
	if (/^#/.test(to)) fail('Open the channel by its id (C…) — channel-name lookup is not supported')
	// @handle / U… / email → a user (DM).
	const user = await actions.resolveUser(flags.team, to)
	if (!user?.id) fail('Could not resolve that user')
	return { teamId: flags.team, user: user.id, threadTs: flags.thread }
}

async function runRead(actions: SlackActions, store: SlackSessionStore, flags: Flags): Promise<void> {
	const baseUrl = daemonBaseUrl(flags.url)
	const target = await resolveTarget(actions, flags, baseUrl)
	const session = await sessionFor(store, target.teamId)
	if (!session) fail('Not connected. Run: helm slack connect')
	const client = new SlackClient({ token: session.token, cookie: session.cookie })
	let channel = target.channel
	if (!channel && target.user) {
		const open = await client.call<{ channel?: { id?: string } }>('conversations.open', { users: target.user })
		channel = open.channel?.id
	}
	if (!channel) fail('No channel/DM to read')
	const limit = Math.min(Math.max(flags.limit ?? 20, 1), 200)
	let messages: SlackMessage[]
	if (target.threadTs) {
		const res = await client.call<SlackRepliesResponse>('conversations.replies', {
			channel,
			ts: target.threadTs,
			limit,
		})
		messages = res.messages ?? []
	} else {
		const res = await client.call<SlackRepliesResponse>('conversations.history', { channel, limit })
		messages = (res.messages ?? []).reverse()
	}
	if (flags.json) {
		console.log(JSON.stringify(messages.map(m => ({ ts: m.ts, user: m.user, text: m.text }))))
		return
	}
	for (const m of messages) {
		const when = slackTsToIso(m.ts)?.slice(11, 16) ?? '--:--'
		const who = m.user ?? (m.bot_id ? 'bot' : 'someone')
		const text = slackMrkdwnToPlain(m.text ?? '', { resolveUser: id => id, resolveChannel: id => id })
		console.log(`${when} ${who}: ${oneLine(text, 400)}`)
	}
}

async function runSend(actions: SlackActions, store: SlackSessionStore, flags: Flags): Promise<void> {
	const baseUrl = daemonBaseUrl(flags.url)
	const to = flags.rest[0]
	const fromSignal = flags.signal !== undefined
	if (!to && !fromSignal) fail('Give --to <target> (or --signal ID)')
	// A positional target alongside --signal is ambiguous and could slip a matching name past the
	// guard while the message goes to the signal's channel; refuse the combination.
	if (to && fromSignal) fail('Give either --to <target> or --signal ID, not both')
	const target = await resolveTarget(actions, flags, baseUrl)
	const session = await sessionFor(store, target.teamId)
	if (!session) fail('Not connected. Run: helm slack connect')

	// Self-only guard. The allowlist (signals.slack.agentSendTo) is security policy, so it is read
	// only from a TRUSTED daemon — the fixed default loopback URL, never the agent-supplied --url /
	// $HELM_URL, which could point at a server that returns a permissive list. A non-loopback or
	// overridden daemon, or HELM_SLACK_SEND_SELF_ONLY, forces self-only. The guard checks only the
	// identifiers the send will actually use (target.channel / target.user), plus the typed `to`
	// ONLY when `to` is what produced the target (never on the --signal path).
	const selfOnly = process.env.HELM_SLACK_SEND_SELF_ONLY === '1' || baseUrl !== DEFAULT_DAEMON_URL
	const allowList = selfOnly
		? []
		: parseAllow(await daemonConfig<string>(DEFAULT_DAEMON_URL, ['signals', 'slack', 'agentSendTo']))
	const isSelf = target.user !== undefined && target.user === session.userId
	const allowed = isSelf || allowList.includes('*') || isAllowed(target, fromSignal ? undefined : to, allowList)
	if (!allowed) {
		fail(
			selfOnly
				? 'Blocked: test sends may only go to your own Slack DM.'
				: 'Blocked: this target is not allowed. Add it to Settings › Signals › "Agents may Slack these targets", or send to yourself.',
		)
	}

	const text = (await readText(flags)).trim()
	if (!text) fail('The message is empty')
	const result = await actions.send(
		target.teamId,
		{ channel: target.channel, user: target.user ?? (isSelf ? session.userId : undefined) },
		text,
		target.threadTs,
	)
	if (!result.ok) fail(`Could not send: ${result.error}`)
	out(flags.json, `Sent to ${to ?? 'the thread'}`, { ok: true, channel: result.channel })
}

export function parseAllow(raw: string | undefined): string[] {
	return (raw ?? '')
		.split('\n')
		.map(line => line.trim().toLowerCase())
		.filter(line => line !== '')
}

export function isAllowed(
	target: { channel?: string; user?: string },
	to: string | undefined,
	allow: string[],
): boolean {
	const candidates = new Set<string>()
	if (target.channel) candidates.add(target.channel.toLowerCase())
	if (target.user) candidates.add(target.user.toLowerCase())
	if (to) {
		candidates.add(to.toLowerCase())
		candidates.add(to.toLowerCase().replace(/^@/, ''))
		candidates.add(to.toLowerCase().replace(/^#/, ''))
	}
	return allow.some(entry => candidates.has(entry) || candidates.has(entry.replace(/^[@#]/, '')))
}

async function sessionFor(store: SlackSessionStore, teamId: string | undefined): Promise<SlackSession | null> {
	if (teamId) {
		const direct = await store.get(teamId)
		if (direct) return direct
		for (const id of await store.list()) {
			const s = await store.get(id)
			if (s && (s.teamId === teamId || s.domain === teamId)) return s
		}
		return null
	}
	const ids = await store.list()
	if (ids.length !== 1) {
		if (ids.length === 0) return null
		fail('Several workspaces are connected; pass --team <id|domain>')
	}
	return store.get(ids[0])
}

// Re-export so tests can build sessions without the real app.
export { sessionInfo }
