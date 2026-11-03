import { memo } from 'react'
import { type SafeMarkdownProfile, renderSafeMarkdown } from '../safe-markdown.js'

/** Remote transcript messages: real links (credential-free http(s)), image notes, GFM tables. */
const REMOTE_MARKDOWN: SafeMarkdownProfile = {
	className: 'remote-markdown',
	plainClassName: 'remote-markdown remote-plain',
	links: 'anchor',
	imageNoteClassName: 'remote-image-note',
	tableClassName: 'remote-table',
}

/** Parse bounded Markdown, never HTML. Only explicit React elements cross the rendering boundary. */
export const RemoteMarkdown = memo(function RemoteMarkdown({ text }: { text: string }) {
	return renderSafeMarkdown(text, REMOTE_MARKDOWN)
})
