// Agent dock wiring for Electron main: the dock watcher polls CompositeDockSource
// (Okena's Claude Remote API + Helm's own Claude hub) and spools to
// <userData>/agent-dock for `helm dock`. Claude in Helm terminals (same launch
// policy as the dock): Helm's hub for the top-level `claude` of every new Helm
// terminal (preload + --settings hooks → <socket root>/claude-remote.sock) is the
// dock's second source. Both push: the hub's onChange and Okena's /v1/stream
// (okena-stream.ts) nudge the watcher, and while the stream is up and covers
// every Okena pane, idle ticks relax to a 15 s reconciliation.
//
// No Electron import: main injects the pty, quarantine, registry and window
// callbacks (they read main-local state), so this module stays testable under node.

import { join } from 'node:path'
import { describeOkenaRaise, raiseOkenaApp } from '../../src/extensions/okena/activate'
import { OkenaClient } from '../../src/extensions/okena/client'
import { ClaudeTranscriptTail } from './agent-dock/claude-transcript-tail'
import { CompositeDockSource } from './agent-dock/composite-source'
import type { AgentDockSnapshot } from './agent-dock/model'
import { AgentDockNotifier, type AgentDockNotifierOptions, type AgentDockUpdate } from './agent-dock/notifier'
import { OkenaClaudeSource } from './agent-dock/okena-claude-source'
import { createOkenaRaiser } from './agent-dock/okena-raise'
import { OkenaStreamSubscription } from './agent-dock/okena-stream'
import { type OkenaRevealDeps, revealOkenaTerminal } from './agent-dock/reveal'
import { AgentDockWatcher } from './agent-dock/watcher'
import type { TerminalRef } from './claude-remote/hub-core'
import { type ClaudeRemote, createClaudeRemote } from './claude-remote/runtime'
import { claudeRemoteTerminalEnvironment } from './claude-remote/token'
import { AGENT_DOCK_IPC } from './shared'

export interface AgentDockMainOptions {
	/** startupPolicy().agentDock: off, neither the dock nor the hub exists (terminals get no hooks). */
	enabled: boolean
	/** sessions.socketNamespaceRoot(). */
	socketRoot: string
	/** Where build.mjs put the preload and hook client (app/dist). */
	distDir: string
	userDataDir: string
	electronPath: string
	/** The active Helm session profile. */
	activeProfileId(): string
	/** Writes to an attached Helm tab's pty; false when no tab holds this terminal (or main refuses it). */
	writeAttached(ref: TerminalRef, data: string): boolean
	/** dtach socket of a parked terminal, or null when it is unreachable (or main refuses it). */
	dtachSocket(ref: TerminalRef): string | null
	dtachBinary(): string | null
	terminalName(ref: TerminalRef): string | undefined
	publish(snapshot: AgentDockSnapshot): void
	isFocused(): boolean
	/** The dock channels' gate: current profile token AND the main window's renderer. */
	acceptsIpc(sender: unknown, profileToken: unknown): boolean
	/**
	 * "Show in Okena" (agent-dock:reveal): the Okena client it focuses through and how it raises the app.
	 * Defaults: a fresh OkenaClient and `raiseOkenaApp` (AppKit, then System Events; macOS) behind
	 * createOkenaRaiser (logs each strategy, says a permission fix once). Tests inject doubles.
	 */
	reveal?: Partial<OkenaRevealDeps>
	/**
	 * Background notifications and the Dock badge (agent-dock/notifier.ts; main builds them from
	 * Electron's Notification and app.dock in agent-dock-notify-main.ts). Absent: neither.
	 */
	notify?: AgentDockNotifierOptions
}

/** The slice of Electron's ipcMain the dock registers on. */
export interface AgentDockIpc {
	on(channel: string, listener: (event: { sender: unknown }, ...args: unknown[]) => void): unknown
	handle(channel: string, listener: (event: { sender: unknown }, ...args: unknown[]) => unknown): unknown
}

export interface AgentDockMain {
	/** Both ordinary spawn sites: the hub's preload/socket/token for a dtach terminal (inherited ones always dropped). */
	terminalEnvironment(env: Record<string, string>, sessionId: string | null): Record<string, string>
	/** Helm's own terminal lifecycle tells the hub a terminal (and its Claude session) is gone. */
	terminalClosed(ref: TerminalRef): void
	poke(): void
	/** The Mac woke or unlocked (powerMonitor resume / unlock-screen): reconnect Okena's stream and sweep. */
	resume(): void
	setVisible(visible: boolean): void
	registerIpc(ipc: AgentDockIpc): void
	/** The notifications setting as main holds it (default on until the renderer reports Jakub's). */
	notificationsEnabled(): boolean
	/** Never blocks startup: an absent Okena is just a "source down" dock. */
	start(): void
	stop(): void
}

export function createAgentDockMain(options: AgentDockMainOptions): AgentDockMain {
	const dockDir = join(options.userDataDir, 'agent-dock')
	let claudeRemote: ClaudeRemote | null = null
	if (options.enabled) {
		try {
			claudeRemote = createClaudeRemote({
				socketRoot: options.socketRoot,
				distDir: options.distDir,
				userDataDir: options.userDataDir,
				agentDockDir: dockDir,
				electronPath: options.electronPath,
				activeProfileId: options.activeProfileId,
				writeAttached: options.writeAttached,
				dtachSocket: options.dtachSocket,
				dtachBinary: options.dtachBinary,
				terminalName: options.terminalName,
			})
		} catch (error) {
			console.warn(
				`[helm] Claude in Helm terminals unavailable: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}
	// Each strategy is bounded inside raiseOkenaApp (AppKit 1.5 s; System Events 4 s: it took ~1.7 s when it had to launch).
	const reveal: OkenaRevealDeps = {
		client: options.reveal?.client ?? new OkenaClient(),
		activate:
			options.reveal?.activate ??
			createOkenaRaiser({
				raise: () => raiseOkenaApp(),
				describe: describeOkenaRaise,
				log: line => console.info(`[helm] agent dock: ${line}`),
			}),
	}
	const okenaClient = new OkenaClient()
	const okenaSource = new OkenaClaudeSource(okenaClient, 'okena', new ClaudeTranscriptTail())
	let watcher: AgentDockWatcher | null = null
	// Notifications follow the watcher (it runs in main, also with the dock hidden or the window in the background).
	const notifier = options.enabled && options.notify ? new AgentDockNotifier(options.notify) : null
	// Okena pushes: a state_changed ticks the dock within ~100 ms (watcher.nudge). One socket, to the
	// profile the Okena source observes; Helm counts as an Okena client (see okena-stream.ts).
	const okenaStream = options.enabled
		? new OkenaStreamSubscription({
				client: okenaClient,
				onChange: () => watcher?.nudge(),
				log: message => console.warn(`[helm] agent dock: ${message}`),
			})
		: null
	watcher = options.enabled
		? new AgentDockWatcher({
				dir: dockDir,
				source: new CompositeDockSource([
					okenaSource,
					...(claudeRemote ? [new OkenaClaudeSource(claudeRemote.hub, 'helm')] : []),
				]),
				publish: options.publish,
				isFocused: options.isFocused,
				...(notifier ? { observe: (update: AgentDockUpdate) => notifier.update(update) } : {}),
				// Helm's hub always pushes (in process); Okena only while its stream is up and every pane reports a lifecycle.
				push: okenaStream
					? { healthy: () => okenaStream.healthy() && okenaSource.pushCovered(), sync: () => okenaStream.sync() }
					: undefined,
			})
		: null
	// Helm terminals push: a hub change ticks the dock within ~100 ms, focused or not (watcher.nudge).
	if (watcher && claudeRemote) claudeRemote.hub.onChange(() => watcher?.nudge())

	return {
		terminalEnvironment: (env, sessionId) =>
			claudeRemote
				? claudeRemote.environment(
						env,
						sessionId ? { profileId: options.activeProfileId(), terminalId: sessionId } : null,
					)
				: claudeRemoteTerminalEnvironment(env, null, null),
		terminalClosed: ref => claudeRemote?.hub.terminalClosed(ref),
		poke: () => watcher?.poke(),
		resume: () => {
			okenaStream?.resume()
			watcher?.nudge()
		},
		setVisible: visible => watcher?.setVisible(visible),
		registerIpc: ipc => {
			// Main renderer only, current profile token last (like the other session channels).
			ipc.on(AGENT_DOCK_IPC.setVisible, (event, visible, profileToken) => {
				if (!options.acceptsIpc(event.sender, profileToken)) return
				watcher?.setVisible(visible === true)
			})
			// Settings → Appearance → "Notify when Helm is in the background" (a renderer preference main obeys).
			ipc.on(AGENT_DOCK_IPC.setNotify, (event, enabled, profileToken) => {
				if (!options.acceptsIpc(event.sender, profileToken) || typeof enabled !== 'boolean') return
				notifier?.setEnabled(enabled)
			})
			ipc.handle(AGENT_DOCK_IPC.ack, async (event, itemId, profileToken) => {
				if (!options.acceptsIpc(event.sender, profileToken)) return false
				if (typeof itemId !== 'number' || !Number.isSafeInteger(itemId) || itemId <= 0) return false
				return (await watcher?.ack(itemId)) ?? false
			})
			// Dock answers: same gate as ack; the watcher validates the request and runs the source's CAS read + POST.
			ipc.handle(AGENT_DOCK_IPC.act, async (event, request, profileToken) => {
				if (!options.acceptsIpc(event.sender, profileToken))
					return {
						ok: false,
						outcome: { status: 'failed', detail: 'This window cannot answer for the current profile.' },
					}
				if (!watcher) return { ok: false, outcome: { status: 'failed', detail: 'The agent dock is off in this run.' } }
				return watcher.act(request)
			})
			// Replies from the agent detail (no item): same gate, same CAS discipline (watcher.prompt).
			ipc.handle(AGENT_DOCK_IPC.prompt, async (event, request, profileToken) => {
				if (!options.acceptsIpc(event.sender, profileToken))
					return {
						ok: false,
						outcome: { status: 'failed', detail: 'This window cannot answer for the current profile.' },
					}
				if (!watcher) return { ok: false, outcome: { status: 'failed', detail: 'The agent dock is off in this run.' } }
				return watcher.prompt(request)
			})
			// The agent detail's full last message: read-only, but transcript text, so the same gate.
			ipc.handle(AGENT_DOCK_IPC.message, async (event, session, profileToken) => {
				if (!options.acceptsIpc(event.sender, profileToken))
					return { ok: false, detail: 'This window cannot read for the current profile.' }
				if (!watcher) return { ok: false, detail: 'The agent dock is off in this run.' }
				return watcher.readMessage(session)
			})
			// "Show in Okena": focus only (never terminal input), but it moves Jakub's Okena: the same gate.
			ipc.handle(AGENT_DOCK_IPC.reveal, async (event, session, profileToken) => {
				if (!options.acceptsIpc(event.sender, profileToken))
					return { ok: false, detail: 'This window cannot show terminals for the current profile.' }
				if (!watcher) return { ok: false, detail: 'The agent dock is off in this run.' }
				return revealOkenaTerminal(session, reveal)
			})
		},
		// The hub listens first so the dock's first Helm poll finds it.
		start: () =>
			void (claudeRemote?.start() ?? Promise.resolve(false)).finally(() => {
				void watcher?.start()
				okenaStream?.start()
			}),
		notificationsEnabled: () => notifier?.isEnabled() ?? false,
		stop: () => {
			okenaStream?.stop()
			watcher?.stop()
			notifier?.dispose()
			claudeRemote?.stop()
		},
	}
}
