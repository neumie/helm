import { useId, useState } from 'react'
import { Btn } from '../button.js'
import { GLYPH } from '../sidebar/ui.js'

/** Transcript-local evidence: one quiet hit target, not an editorial Section wrapper. */
export function RemoteDisclosure({ label, text }: { label: string; text: string }) {
	const [open, setOpen] = useState(false)
	const id = useId()
	return (
		<div className="remote-evidence">
			<Btn tone="ghost" ariaExpanded={open} ariaControls={id} onClick={() => setOpen(value => !value)}>
				{open ? GLYPH.chevronDown : GLYPH.chevronRight}
				{label}
			</Btn>
			<div id={id} hidden={!open}>
				{open && <pre>{text}</pre>}
			</div>
		</div>
	)
}
