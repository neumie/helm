// New item — a sheet over the pane (§3.9). Minimal fields; the daemon route
// validates everything server-side (POST /api/items via the bridge).

import { useMemo, useState } from 'react'
import type { CreateItemInput, HelmSnapshot } from '../../shared-helm'
import { showToast } from '../toast'
import { Btn, FieldLabel, Segmented, SelectInput, Sheet, TextArea, TextInput } from './ui'

type Kind = 'solve' | 'ralph' | 'harden'

const KIND_FIELD: Record<Kind, { label: string; placeholder: string }> = {
	solve: { label: 'Prompt', placeholder: 'What should the agent do?' },
	ralph: { label: 'PRD path', placeholder: 'docs/plans/…/prd.md' },
	harden: { label: 'Target', placeholder: 'Module or path to harden' },
}

export function NewItemSheet({
	snapshot,
	onClose,
	onCreated,
}: {
	snapshot: HelmSnapshot | null
	onClose: () => void
	onCreated: (id: string) => void
}) {
	const projects = useMemo(() => {
		const fromConfig = (snapshot?.config?.projects ?? []).map(p => p.slug)
		const fromItems = (snapshot?.items ?? []).map(i => i.projectSlug)
		return [...new Set([...fromConfig, ...fromItems])]
	}, [snapshot])

	const [kind, setKind] = useState<Kind>('solve')
	const [project, setProject] = useState(projects[0] ?? '')
	const [title, setTitle] = useState('')
	const [body, setBody] = useState('') // prompt / prdPath / target, per kind
	const [baseRef, setBaseRef] = useState('')
	const [busy, setBusy] = useState(false)

	const valid = title.trim() !== '' && project !== '' && body.trim() !== ''

	const create = async () => {
		if (!valid || busy) return
		const common = {
			title: title.trim(),
			projectSlug: project,
			...(baseRef.trim() ? { baseRef: baseRef.trim() } : {}),
		}
		const input: CreateItemInput =
			kind === 'solve'
				? { kind, ...common, prompt: body.trim() }
				: kind === 'ralph'
					? { kind, ...common, prdPath: body.trim() }
					: { kind, ...common, target: body.trim() }
		setBusy(true)
		try {
			const result = await window.helm.daemon.createItem(input)
			if (result.error !== undefined) {
				showToast({ message: 'Create failed', detail: result.error, ttlMs: 6000 })
				return
			}
			const first = Array.isArray(result.data) ? result.data[0] : result.data
			onClose()
			if (first) onCreated(first.id)
		} finally {
			setBusy(false)
		}
	}

	return (
		<Sheet
			title="New item"
			onClose={onClose}
			footer={
				<>
					<Btn tone="quiet" onClick={onClose}>
						Cancel
					</Btn>
					<Btn tone="primary" disabled={!valid} busy={busy} onClick={() => void create()}>
						Create item
					</Btn>
				</>
			}
		>
			<div className="sheet-field">
				<FieldLabel>Kind</FieldLabel>
				<Segmented<Kind>
					label="Item kind"
					value={kind}
					onChange={setKind}
					options={[
						{ value: 'solve', label: 'Solve' },
						{ value: 'ralph', label: 'Ralph' },
						{ value: 'harden', label: 'Harden' },
					]}
				/>
			</div>
			<div className="sheet-field">
				<FieldLabel htmlFor="new-item-project">Project</FieldLabel>
				<SelectInput
					id="new-item-project"
					value={project}
					onChange={setProject}
					options={projects.map(slug => ({ value: slug, label: slug }))}
				/>
			</div>
			<div className="sheet-field">
				<FieldLabel htmlFor="new-item-title">Title</FieldLabel>
				<TextInput id="new-item-title" value={title} onChange={setTitle} placeholder="Short name for the work" />
			</div>
			<div className="sheet-field">
				<FieldLabel htmlFor="new-item-body">{KIND_FIELD[kind].label}</FieldLabel>
				{kind === 'solve' ? (
					<TextArea id="new-item-body" value={body} onChange={setBody} placeholder={KIND_FIELD[kind].placeholder} />
				) : (
					<TextInput id="new-item-body" value={body} onChange={setBody} placeholder={KIND_FIELD[kind].placeholder} />
				)}
			</div>
			<div className="sheet-field">
				<FieldLabel htmlFor="new-item-base">Base ref</FieldLabel>
				<TextInput id="new-item-base" value={baseRef} onChange={setBaseRef} placeholder="Project default branch" />
			</div>
		</Sheet>
	)
}
