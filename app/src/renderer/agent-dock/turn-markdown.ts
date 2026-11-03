// The turn pane's last message as bounded Markdown (design §3.24 Turn). Agent text stays untrusted:
// it is control/bidi-stripped and length-bounded by plainAgentText first, then lexed by the shared
// safe renderer into explicit React elements — no HTML, links as their text, images as their alt text,
// tables as their source.
import type { ReactNode } from 'react'
import { type SafeMarkdownProfile, renderSafeMarkdown } from '../safe-markdown'
import { plainAgentText } from './presentation'

const TURN_MARKDOWN: SafeMarkdownProfile = {
	className: 'agent-dock-md',
	plainClassName: 'agent-dock-md agent-dock-md-plain',
	links: 'text',
	imageNoteClassName: null,
	tableClassName: null,
}

/** The message as Markdown elements, or null when it has no text (the pane then shows the headline). */
export function turnMessage(text: unknown): ReactNode {
	const clean = plainAgentText(text)
	return clean.trim() === '' ? null : renderSafeMarkdown(clean, TURN_MARKDOWN)
}
