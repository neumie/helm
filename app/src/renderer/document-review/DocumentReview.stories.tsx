import type { Meta, StoryObj } from '@storybook/react-vite'
import { StrictMode, useEffect, useMemo, useState } from 'react'
import type { ReviewApi } from '../../document-review/types'
import './document-review.css'
import '../styles.css'
import '../sidebar/sidebar.css'
import { DocumentReview } from './DocumentReview'
import { createCanvasReviewFixture } from './canvas-fixtures'
import type { CanvasFixtureScenario } from './canvas-fixtures'
import { createReviewFixture } from './fixtures'
import type { ReviewFixtureScenario } from './fixtures'
import { createLegacyProjectionFixture } from './legacy-projection-fixture'

declare global {
	interface Window {
		__helmDocumentReviewProof?: ReturnType<typeof createReviewFixture> & { replaceApi: () => void }
		__helmCanvasReviewProof?: ReturnType<typeof createCanvasReviewFixture>
		__helmLegacyReviewProof?: ReturnType<typeof createLegacyProjectionFixture>
	}
}
function LegacyProjectionFixture() {
	const fixture = useMemo(() => createLegacyProjectionFixture(), [])
	useEffect(() => {
		window.__helmLegacyReviewProof = fixture
		return () => {
			if (window.__helmLegacyReviewProof === fixture) window.__helmLegacyReviewProof = undefined
		}
	}, [fixture])
	return <DocumentReview api={fixture.api} />
}

function ReviewFixture({ scenario = 'normal' }: { scenario?: ReviewFixtureScenario }) {
	const fixture = useMemo(() => createReviewFixture(scenario), [scenario])
	const [replacement, setReplacement] = useState<{ fixture: typeof fixture; api: ReviewApi } | null>(null)
	const proof = useMemo(
		() => ({
			...fixture,
			replaceApi: () => setReplacement({ fixture, api: { ...fixture.api } }),
		}),
		[fixture],
	)
	useEffect(() => {
		window.__helmDocumentReviewProof = proof
		return () => {
			if (window.__helmDocumentReviewProof === proof) window.__helmDocumentReviewProof = undefined
			fixture.dispose()
		}
	}, [fixture, proof])
	return <DocumentReview api={replacement?.fixture === fixture ? replacement.api : fixture.api} />
}
function CanvasReviewFixture({ scenario }: { scenario: CanvasFixtureScenario }) {
	const fixture = useMemo(() => createCanvasReviewFixture(scenario), [scenario])
	useEffect(() => {
		window.__helmCanvasReviewProof = fixture
		return () => {
			if (window.__helmCanvasReviewProof === fixture) window.__helmCanvasReviewProof = undefined
			fixture.dispose()
		}
	}, [fixture])
	return <DocumentReview api={fixture.api} />
}

const meta = {
	title: 'Views/Document review',
	component: ReviewFixture,
	parameters: { layout: 'fullscreen' },
	args: { scenario: 'normal' },
} satisfies Meta<typeof ReviewFixture>
export default meta
type Story = StoryObj<typeof meta>
export const Reading: Story = {}
export const NativeEntryLifecycle: Story = {
	render: () => (
		<StrictMode>
			<ReviewFixture scenario="not-listening" />
		</StrictMode>
	),
	parameters: {
		docs: {
			description: {
				story:
					'Exercises the desktop entry’s StrictMode lifecycle with a paused display caller. Effect-owned popover cleanup must not dismiss passage writing; real Close/Escape/outside dismissal still preserves the draft. The built-entry browser gate separately loads the actual compiled renderer and native CSP with fixture preload IO, not Electron or live-caller certification.',
			},
		},
	},
}
export const CliEditing: Story = {
	args: { scenario: 'cli' },
	parameters: {
		docs: {
			description: {
				story:
					'helm edit FILE opens and listens without provider flags. An unspecified caller displays Agent honestly; no provider identity is inferred. This is a display fixture, not CLI or installed-agent delivery certification.',
			},
		},
	},
}
export const MultipleConnectedAgents: Story = {
	args: { scenario: 'multiple-callers' },
	parameters: {
		docs: {
			description: {
				story:
					'The conversation that opened this document owns its feedback. Other connected callers never add a picker or change that binding. This is a display fixture, not native caller admission certification.',
			},
		},
	},
}
export const LegacyProjectedNotes: Story = { render: () => <LegacyProjectionFixture /> }
export const InteractiveCanvas: Story = { render: () => <CanvasReviewFixture scenario="interactive" /> }
export const InteractiveCanvasLight: Story = { render: () => <CanvasReviewFixture scenario="light" /> }
export const InteractiveCanvasCompact: Story = {
	render: () => <CanvasReviewFixture scenario="compact" />,
	parameters: { viewport: { defaultViewport: 'mobile1' } },
}
export const SavedReviewHistory: Story = { render: () => <CanvasReviewFixture scenario="archive" /> }
export const SavedReviewStale: Story = { render: () => <CanvasReviewFixture scenario="stale" /> }
export const SavedReviewUnconfirmed: Story = { render: () => <CanvasReviewFixture scenario="unconfirmed" /> }
export const SavedReviewRejected: Story = { render: () => <CanvasReviewFixture scenario="rejected" /> }
export const CanvasCompileError: Story = { render: () => <CanvasReviewFixture scenario="compile-error" /> }
export const CanvasNoCaller: Story = { render: () => <CanvasReviewFixture scenario="no-caller" /> }
export const ReviewPersistenceFailure: Story = { render: () => <CanvasReviewFixture scenario="save-error" /> }
export const CommentPersistenceFailure: Story = { render: () => <CanvasReviewFixture scenario="comment-save-error" /> }
export const Editorial: Story = {
	args: { scenario: 'editorial' },
	parameters: {
		docs: {
			description: {
				story:
					'A single connected conversation shows only its bounded name and status. Empty chat has no setup or help block; the existing composer is the invitation to write.',
			},
		},
	},
}
export const EditorialLight: Story = { args: { scenario: 'editorial-light' } }
export const ContentsNavigation: Story = {
	args: { scenario: 'editorial' },
	parameters: {
		docs: {
			description: {
				story:
					'Filename, compact Contents and document-options dots share one header. Contents reserves a side rail when prose has room, otherwise a bounded section above reading. It never covers the document. Section navigation never changes passage scope or sends feedback.',
			},
		},
	},
}
export const WritingFirst: Story = {
	args: { scenario: 'editorial' },
	parameters: {
		docs: {
			description: {
				story:
					'Drag a passage to open and focus its anchored editable chat bubble. The companion always discusses the whole document. Re-selecting preserves passage writing without copying the whole-document draft. The document highlight supplies context; the exact quote stays attached internally. Ask is the initial default; choose Request change from its checked menu. Writing options opens beside its dots trigger; local comment save stays secondary. Return to document preserves the passage draft. Saved comment associations and re-anchor require explicit acceptance; active operations block scope changes. Keyboard selection stays in the document until Alt+Enter. No per-block controls interrupt prose.',
			},
		},
	},
}
export const PassageConversations: Story = {
	args: { scenario: 'passage-threads' },
	parameters: {
		docs: {
			description: {
				story:
					'Admitted passage questions have a margin comment icon. Its bubble opens passage writing and shows only its questions and replies, without repeating the quote. Whole-document messages stay in the companion; busy callers can draft locally while Send and local Save remain disabled. Revisions and owner changes retire the bubble without relocating it.',
			},
		},
	},
}
export const PassageConversationsLight: Story = { args: { scenario: 'passage-threads-light' } }
export const PassageLongReply: Story = {
	args: { scenario: 'passage-threads-long' },
	parameters: {
		docs: {
			description: {
				story:
					'Open a margin comment to read a long reply in the responsive 560px passage bubble. Its height grows up to 640px, leaving the writing row visible while replies scroll independently. Empty writing stays compact; resizing never changes scope, drafts or focus. Display-only fixture, not native delivery proof.',
			},
		},
	},
}
export const PassageLongReplyLight: Story = { args: { scenario: 'passage-threads-long-light' } }
export const PassageList: Story = {
	args: { scenario: 'passage-list' },
	parameters: {
		docs: {
			description: {
				story:
					'Different questions within one numbered-list source block anchor to their actual passage lines, not the first list item. Opening highlights only the associated text; the quote is not repeated in the bubble.',
			},
		},
	},
}
export const PassageListLight: Story = { args: { scenario: 'passage-list-light' } }
export const Light: Story = { args: { scenario: 'light' } }
export const Working: Story = { args: { scenario: 'working' } }
export const MissingFile: Story = { args: { scenario: 'missing' } }
export const UnknownOutcome: Story = { args: { scenario: 'uncertain' } }
export const Comments: Story = { args: { scenario: 'comments' } }
export const StaleAnchor: Story = { args: { scenario: 'stale' } }
export const Changes: Story = { args: { scenario: 'changes' } }
export const SaveFailure: Story = { args: { scenario: 'save-failure' } }
export const NoConnectedAgent: Story = { args: { scenario: 'no-agent' } }
export const ListenerPaused: Story = {
	args: { scenario: 'not-listening' },
	parameters: {
		docs: {
			description: {
				story:
					'Only the conversation name and paused status are shown, without a redundant single-choice form or nested help. Send stays disabled; the registered owner is not disconnected.',
			},
		},
	},
}

export const PassageFeedback: Story = {
	parameters: {
		docs: {
			description: {
				story:
					'Select text to open passage writing. Pointer selection opens and focuses passage writing in a nonmodal bubble, not the companion. Its draft survives dismissal; whole-document writing remains separate. Keyboard selection stays extendable until Alt+Enter. No per-block Review control or automatic fixture admission.',
			},
		},
	},
}

export const EmptyPreferencesRecovery: Story = {
	args: { scenario: 'empty-preferences' },
	parameters: {
		docs: {
			description: {
				story:
					'Document options → Document details exposes explicit empty-preference cleanup when supported. This display fixture returns a count only; saved text, comments and the current editor remain unchanged.',
			},
		},
	},
}
