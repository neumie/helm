import { useState } from 'react'
import type { DashboardItem } from '../../shared-helm'
import { UNTITLED_ITEM_TITLE } from '../../shared-helm'
import { showToast } from '../toast'
import { Btn, FieldLabel, SelectInput, Sheet, TextInput } from './ui'

export function AssignItemSheet({
	item,
	projects,
	onClose,
	onAssigned,
}: {
	item: DashboardItem
	projects: Array<{ slug: string }>
	onClose: () => void
	onAssigned: () => void
}) {
	const [projectSlug, setProjectSlug] = useState('')
	const [title, setTitle] = useState(item.title === UNTITLED_ITEM_TITLE ? '' : item.title)
	const [busy, setBusy] = useState(false)
	const valid = projectSlug !== ''

	const assign = async () => {
		if (!valid || busy) return
		const trimmedTitle = title.trim()
		setBusy(true)
		try {
			const result = await window.helm.daemon.assignItem(item.id, {
				projectSlug,
				...(trimmedTitle ? { title: trimmedTitle } : {}),
			})
			if (result.error !== undefined) {
				showToast({ message: 'Setup failed', detail: result.error, ttlMs: 6000 })
				return
			}
			onClose()
			onAssigned()
			showToast({ message: 'Item ready' })
		} finally {
			setBusy(false)
		}
	}

	return (
		<Sheet
			title="Finish item setup"
			description="Choose where this item will run."
			onClose={onClose}
			footer={
				<>
					<Btn tone="quiet" onClick={onClose}>
						Cancel
					</Btn>
					<Btn tone="primary" disabled={!valid} busy={busy} onClick={() => void assign()}>
						Save
					</Btn>
				</>
			}
		>
			<div className="sheet-field">
				<FieldLabel htmlFor="assign-item-project">Project</FieldLabel>
				<SelectInput
					id="assign-item-project"
					value={projectSlug}
					onChange={setProjectSlug}
					options={[
						{ value: '', label: 'Choose a project…' },
						...projects.map(project => ({ value: project.slug, label: project.slug })),
					]}
					disabled={projects.length === 0}
					required
				/>
			</div>
			<div className="sheet-field">
				<FieldLabel htmlFor="assign-item-title">Title (optional)</FieldLabel>
				<TextInput id="assign-item-title" value={title} onChange={setTitle} placeholder={UNTITLED_ITEM_TITLE} />
			</div>
			{projects.length === 0 ? (
				<p className="section-description">Add a project in Settings before finishing setup.</p>
			) : null}
		</Sheet>
	)
}
