import type { Meta, StoryObj } from '@storybook/react-vite'
import { Profiler, useEffect, useState } from 'react'
import { RemoteWorkspace } from './RemoteWorkspace.js'
import { RemoteEntry } from './entry.js'
import { FAVORITES_FIXTURE_TOKEN, enableFavoritesFixture } from './favorites-fixture.js'
import type { HistoryFixtureState } from './history-fixture.js'
import { type ImageInputFixture, createImageInputFixture } from './image-input-fixtures.js'
import {
	type RemoteEntryTestFixture,
	type RemoteFixture,
	createRemoteEntryFixture,
	createRemoteFixture,
} from './remote-fixtures.js'
import { createRemoteTransport } from './transport.js'
import { enableUsageFixture } from './usage-fixture.js'

declare global {
	interface Window {
		__remoteFixture?: RemoteFixture
		__remoteEntryFixture?: RemoteEntryTestFixture & { dispose(): void }
		__remoteRenderDurations?: number[]
	}
}
function Harness({
	subagentsExample = false,
	informationExample = false,
	question = false,
	working = false,
	revoked = false,
	readOnly = false,
	scoped = false,
	composerExample = false,
	readingEdgeExample = false,
	submitFeedbackExample = false,
	compactHeaderExample = false,
	markdownExample = false,
	plainThinkingExample = false,
	chainedExample = false,
	terminalMetadataExample = false,
	rowDensityExample = false,
	historyExample = false,
	historyScrollExample = false,
	imageInputExample = false,
	favoritesExample = false,
	favoritesWireExample = false,
	usageExample = false,
	usageSignedOutExample = false,
	historyState,
}: {
	subagentsExample?: boolean
	informationExample?: boolean
	question?: boolean
	working?: boolean
	revoked?: boolean
	readOnly?: boolean
	scoped?: boolean
	composerExample?: boolean
	readingEdgeExample?: boolean
	submitFeedbackExample?: boolean
	compactHeaderExample?: boolean
	markdownExample?: boolean
	plainThinkingExample?: boolean
	chainedExample?: boolean
	terminalMetadataExample?: boolean
	rowDensityExample?: boolean
	historyExample?: boolean
	historyScrollExample?: boolean
	imageInputExample?: boolean
	favoritesExample?: boolean
	favoritesWireExample?: boolean
	usageExample?: boolean
	usageSignedOutExample?: boolean
	historyState?: HistoryFixtureState
}) {
	const [workspaceMounted, setWorkspaceMounted] = useState(true)
	const [fixture] = useState(() => {
		const value = imageInputExample ? createImageInputFixture() : createRemoteFixture()
		if (favoritesExample) enableFavoritesFixture(value.transport)
		if (usageExample || usageSignedOutExample)
			enableUsageFixture(value.transport, usageSignedOutExample ? 'signed-out' : 'ready')
		if (favoritesWireExample) Object.assign(value.transport, createRemoteTransport(FAVORITES_FIXTURE_TOKEN))
		if (subagentsExample) {
			const activity = { availability: 'available', coverage: 'limited', active: true } as const
			const directory = value.transport.directory.bind(value.transport)
			const detail = value.transport.detail.bind(value.transport)
			value.transport.directory = async (...args) => {
				const result = await directory(...args)
				return {
					...result,
					sessions: result.sessions.map(row => ({ ...row, subagents: activity, subagentsFreshForMs: 5000 })),
				}
			}
			value.transport.detail = async (...args) => {
				const result = await detail(...args)
				return { ...result, snapshot: { ...result.snapshot, subagents: activity, subagentsFreshForMs: 5000 } }
			}
		}
		if (informationExample) value.enableInformation()
		if (historyExample || historyScrollExample || historyState) value.enableHistory(440, false, historyState)
		if (composerExample) value.showComposerExample()
		if (submitFeedbackExample) {
			const send = value.transport.send.bind(value.transport)
			value.transport.send = async (...args) => {
				// Workbench-only latency: the production editor must clear before this receipt.
				await new Promise(resolve => setTimeout(resolve, 2000))
				return send(...args)
			}
		}
		if (compactHeaderExample) {
			value.showTerminalMetadataExample()
			const read = value.transport.directory.bind(value.transport)
			value.transport.directory = async (...args) => {
				const result = await read(...args)
				const terminal = result.sessions[0]?.terminal
				if (terminal) terminal.name = 'A long native conversation title with an important distinguishing suffix alpha'
				return result
			}
		}
		if (markdownExample) value.showMarkdownExample()
		if (plainThinkingExample) {
			value.showMarkdownExample()
			const detail = value.transport.detail.bind(value.transport)
			value.transport.detail = async (...args) => {
				const result = await detail(...args)
				result.snapshot.messages = [
					{
						id: 'plain-thinking-story',
						role: 'assistant',
						text: '',
						thinking: '**Thinking:** **Inspect *nested* emphasis** while preserving `**code**` and src/*/tests/*.',
						truncated: false,
					},
					{ id: 'label-only-story', role: 'assistant', text: '', thinking: '**Thinking:**', truncated: false },
				]
				return result
			}
		}
		if (chainedExample) value.showChainedExample()
		if (rowDensityExample) value.showTerminalMetadataExample(null, 3)
		else if (terminalMetadataExample) value.showTerminalMetadataExample()
		if (working) value.setActivity('working')
		if (question) value.ask()
		if (readOnly) value.setReadOnly(true)
		if (scoped) value.addScopedSession()
		if (revoked) value.revoke()
		return value
	})
	useEffect(() => {
		if (imageInputExample) (fixture as ImageInputFixture).bindWorkspaceMount(setWorkspaceMounted)
	}, [fixture, imageInputExample])
	useEffect(() => {
		window.__remoteFixture = fixture
		return () => {
			window.__remoteFixture = undefined
		}
	}, [fixture])
	useEffect(() => {
		if (!workspaceMounted) return
		if (
			!composerExample &&
			!readingEdgeExample &&
			!markdownExample &&
			!chainedExample &&
			!historyScrollExample &&
			!historyState &&
			!working &&
			!imageInputExample
		)
			return
		let frame = 0
		let attempts = 0
		const open = () => {
			const row = document.querySelector<HTMLButtonElement>('.remote-session-row')
			if (row) {
				row.click()
				if (historyState) {
					const load = () => {
						const transcript = document.querySelector<HTMLElement>('.remote-transcript')
						if (transcript) transcript.scrollTop = 0
						const button = document.querySelector<HTMLButtonElement>('.remote-history-entry .btn')
						if (button && button.getAttribute('aria-disabled') !== 'true') button.click()
						else if (++attempts < 60) frame = requestAnimationFrame(load)
					}
					frame = requestAnimationFrame(load)
				}
			} else if (++attempts < 60) frame = requestAnimationFrame(open)
		}
		frame = requestAnimationFrame(open)
		return () => cancelAnimationFrame(frame)
	}, [
		composerExample,
		readingEdgeExample,
		markdownExample,
		chainedExample,
		historyScrollExample,
		historyState,
		working,
		imageInputExample,
		workspaceMounted,
	])
	return (
		<Profiler
			id="Remote workspace"
			onRender={(_id, _phase, duration) => {
				const values = window.__remoteRenderDurations ?? []
				values.push(duration)
				window.__remoteRenderDurations = values.slice(-300)
			}}
		>
			{workspaceMounted ? <RemoteWorkspace transport={fixture.transport} /> : <div data-testid="remote-unmounted" />}
		</Profiler>
	)
}
const meta = { title: 'Views/Helm Remote', component: Harness, parameters: { layout: 'fullscreen' } } satisfies Meta<
	typeof Harness
>
export default meta
type Story = StoryObj<typeof meta>
export const BrowserHarness: Story = {}
export const Favorites: Story = {
	args: { favoritesExample: true },
	parameters: {
		docs: {
			description: {
				story:
					'Shared favorite controls and stable favorites-first ordering. This display-only service does not prove persistence or device authorization; the separate wire suite drives the production transport and host.',
			},
		},
	},
}
export const FavoritesReadOnly: Story = { args: { favoritesExample: true, readOnly: true } }
export const Usage: Story = {
	args: { usageExample: true },
	parameters: {
		docs: {
			description: {
				story:
					'The Usage destination beside the session list. Percentages, reset distances and the pace hairline are rendered from a fixture; this does not prove any provider was reached.',
			},
		},
	},
}
export const UsageSignedOut: Story = { args: { usageSignedOutExample: true } }
export const FavoritesWire: Story = { args: { favoritesWireExample: true } }
export const ImageInput: Story = {
	args: { imageInputExample: true },
	parameters: {
		docs: {
			description: {
				story:
					'Opt-in production composer with a shared Add images IconBtn that directly opens the system picker, without an intermediate menu or native-input overlay. Exercise repeated touch/pointer opens, Enter/Space, chooser cancellation and same-file reselection after removal. Bounded PNG/JPEG preparation, exact processed previews, removal, image-only sending and local bundle recovery remain unchanged. This fixture is browser-only proof, not physical-phone or provider-consumption certification.',
			},
		},
	},
}
export const ImmediateSubmitFeedback: Story = {
	args: { submitFeedbackExample: true },
	parameters: {
		docs: {
			description: {
				story:
					'Production prompt admission clears locally while this fixture holds the receipt for two seconds. Type a new draft while Sending: completion must leave that newer editor untouched.',
			},
		},
	},
}
export const CompactHeader: Story = {
	args: { compactHeaderExample: true },
	parameters: {
		docs: {
			description: {
				story:
					'Only a frosted 44px navigation circle floats over the transparent chat. The drawer shows the full conversation name and opens Model; composer More → Info exposes the title, honest source and unavailable accounting even without exporters.',
			},
		},
	},
}
export const Information: Story = {
	args: { informationExample: true, historyExample: true },
	parameters: {
		docs: {
			description: {
				story:
					'Info holds the honest source, safe input-plus-output reported total and context percentage alongside individual input/output and context-window evidence. There is no information footer above the input: the composer is transparent, only the writing capsule is filled. Projected assistant thinking remains literal visible text while tool activity stays opt-in.',
			},
		},
	},
}
export const InformationQuestion: Story = { args: { informationExample: true, question: true } }
export const Working: Story = { args: { working: true } }
export const WorkingWithHistory: Story = { args: { working: true, historyExample: true } }
export const HistoryScroll: Story = {
	args: { historyScrollExample: true },
	parameters: {
		docs: {
			description: {
				story:
					'Scroll upward in the conversation to load an older range once, then keep scrolling upward across bounded pages. The centered Earlier messages button remains a fallback for short/empty chats; no history read occurs just because the story mounted.',
			},
		},
	},
}
export const HistoryReader: Story = { args: { historyExample: true } }
export const HistoryProgress: Story = { args: { historyState: 'progress' } }
export const HistoryExpired: Story = { args: { historyState: 'expired' } }
export const HistoryProgressQuestion: Story = { args: { historyState: 'progress', question: true } }
export const HistoryExpiredQuestion: Story = { args: { historyState: 'expired', question: true } }
export const HistoryGap: Story = { args: { historyState: 'gap' } }
export const HistoryUnsupported: Story = { args: { historyState: 'unsupported' } }
export const Composer: Story = {
	args: { composerExample: true },
	parameters: {
		docs: {
			description: {
				story:
					'At 390×420, the unfocused capsule is one compact row with More, the delivery-mode chooser, and Send. Change Steer/Follow-up directly there without opening the editor. Focus the editor, even while empty, to reveal a taller writing row above the same More, delivery and Send (plus Interrupt during observed work). Delivery uses a turn arrow for Steer during work and a down-to-tray arrow for Follow-up after current work; switching modes changes only this glyph and its existing label, not queue management. Type six lines to see the editor grow and scroll; blur it to return to one visible line without losing the draft. The frosted capsule remains the only styled bottom surface.',
			},
		},
	},
}
export const ReadingEdge: Story = {
	args: { readingEdgeExample: true },
	parameters: {
		docs: {
			description: {
				story:
					'Scroll this long live conversation: text passes behind the frosted navigation circle and its quiet inset glass rim, with no full-width header blur or bottom veil. The input capsule and floating Jump to latest pill share that light-catching edge; the transparent composer and scroll owner remain unchanged.',
			},
		},
	},
}
export const Reading: Story = {
	args: { markdownExample: true },
	parameters: {
		docs: {
			description: {
				story:
					'Markdown remains parser-safe; already-projected assistant thinking is always expanded, selectable literal text with terminal formatting normalized and no disclosure.',
			},
		},
	},
}
export const PlainThinking: Story = {
	args: { plainThinkingExample: true },
	parameters: {
		docs: {
			description: {
				story:
					'Source-preserving plain thinking: recognized emphasis and a leading label disappear; code and globs remain literal. The label-only message has no visible row or canonical reading anchor.',
			},
		},
	},
}
export const ChainedReply: Story = { args: { chainedExample: true } }
export const TerminalMetadata: Story = { args: { terminalMetadataExample: true } }
export const Readability: Story = { args: { terminalMetadataExample: true } }
export const RowDensity: Story = { args: { rowDensityExample: true } }
export const LiveScopes: Story = { args: { scoped: true } }
export const Questions: Story = { args: { question: true } }
export const QuestionsReadOnly: Story = { args: { question: true, readOnly: true } }
export const AccessEnded: Story = { args: { revoked: true } }
function PairingHarness({
	qr = false,
	authenticated = false,
	unavailable = false,
}: { qr?: boolean; authenticated?: boolean; unavailable?: boolean }) {
	const [value] = useState(() => createRemoteEntryFixture(qr, authenticated, unavailable))
	const [mounted, setMounted] = useState(true)
	useEffect(() => {
		window.__remoteEntryFixture = { ...value, dispose: () => setMounted(false) }
		return () => {
			window.__remoteEntryFixture = undefined
		}
	}, [value])
	return mounted ? <RemoteEntry fixture={value.fixture} /> : <p>Entry disposed</p>
}
export const PairingEntry: Story = { render: () => <PairingHarness /> }
export const PairingFromQr: Story = { render: () => <PairingHarness qr /> }
export const PairingRecovery: Story = { render: () => <PairingHarness authenticated /> }

export const AccessUnavailable: Story = { render: () => <PairingHarness authenticated unavailable /> }

export const Subagents: Story = {
	args: { subagentsExample: true },
	parameters: {
		docs: {
			description: {
				story: 'Opt-in limited observed subagent activity; not installed-Pi, fleet, or command-authority proof.',
			},
		},
	},
}
