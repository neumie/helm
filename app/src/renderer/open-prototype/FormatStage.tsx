// Neutral host for the C (format view) stories: renderer + one status line. No chrome decision.
import { type ComponentType, useState } from 'react'
import './open.css'
import type { FeedbackHost, RendererProps, ViewerFile, ViewerStatus } from './types'
import { formatBytes, formatWord } from './types'

export function FormatStage({
	file,
	Renderer,
	zoom,
	feedback = null,
}: {
	file: ViewerFile
	Renderer: ComponentType<RendererProps>
	zoom?: number
	feedback?: FeedbackHost | null
}) {
	const [status, setStatus] = useState<ViewerStatus>({})
	return (
		<div className="open-stage">
			<div className="open-body">
				<Renderer file={file} zoom={zoom} onStatus={setStatus} feedback={feedback} />
			</div>
			<div className="open-format-status" aria-label="Viewer status">
				<b>{file.name}</b>
				<span>{formatWord(file)}</span>
				<span>{formatBytes(file.size)}</span>
				{status.facts?.map(fact => (
					<span key={fact}>{fact}</span>
				))}
				{status.position ? <span className="open-status-end">{status.position}</span> : null}
			</div>
		</div>
	)
}
