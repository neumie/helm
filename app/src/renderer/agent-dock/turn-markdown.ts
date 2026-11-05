// The turn pane's last message as bounded Markdown (design §3.24 Turn). Agent text stays untrusted:
// it is control/bidi-stripped and length-bounded by plainAgentText first, then lexed by the shared
// safe renderer into explicit React elements — no HTML, images as their alt text, tables as their source.
// Credential-free http(s) links (Markdown, <autolinks>, bare GFM URLs) are anchors that open in the
// host's browser through Helm's external bridge (main re-validates); every other scheme stays text.
import type { ReactNode } from 'react'
import { type SafeMarkdownProfile, renderSafeMarkdown } from '../safe-markdown'
import { plainAgentText } from './presentation'

/** The browser handoff the rest of Helm uses (`HelmApi.external`), looked up when a link is activated. */
const openInBrowser = (href: string): void => {
	void window.helm?.external.open(href)
}

const turnProfile = (open: (href: string) => void): SafeMarkdownProfile => ({
	className: 'agent-dock-md',
	plainClassName: 'agent-dock-md agent-dock-md-plain',
	links: { open },
	imageNoteClassName: null,
	tableClassName: null,
})

const TURN_MARKDOWN = turnProfile(openInBrowser)

/**
 * The message as Markdown elements, or null when it has no text (the pane then shows the headline).
 * `max` bounds it (default: the turn excerpt's 2 KiB; the agent detail's live read is longer).
 */
export function turnMessage(text: unknown, open?: (href: string) => void, max?: number): ReactNode {
	const clean = plainAgentText(text, max)
	return clean.trim() === '' ? null : renderSafeMarkdown(clean, open ? turnProfile(open) : TURN_MARKDOWN)
}
