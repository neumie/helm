// New item — a title-or-prompt pushed composer (§3.10). Repository assignment is
// deliberately deferred to Item detail; the daemon owns draft defaults.

import { useEffect, useRef, useState } from 'react'
import type { CreateItemInput } from '../../shared-helm'
import { showToast } from '../toast'
import { Btn, FieldLabel, PushHeader, TextArea, TextInput } from './ui'

export interface NewItemDraft {
	title: string
	prompt: string
}

export function NewItemPage({
	draft,
	onDraftChange,
	onBack,
	onCreated,
	onSubmittingChange,
}: {
	draft: NewItemDraft
	onDraftChange: (draft: NewItemDraft) => void
	onBack: () => void
	onCreated: (id: string) => void
	onSubmittingChange?: (submitting: boolean) => void
}) {
	const [busy, setBusy] = useState(false)
	const mounted = useRef(true)
	const valid = draft.title.trim() !== '' || draft.prompt.trim() !== ''

	useEffect(() => {
		mounted.current = true
		return () => {
			mounted.current = false
			onSubmittingChange?.(false)
		}
	}, [onSubmittingChange])

	const setSubmitting = (submitting: boolean) => {
		if (mounted.current) setBusy(submitting)
		onSubmittingChange?.(submitting)
	}

	const create = async () => {
		if (!valid || busy) return
		const trimmedTitle = draft.title.trim()
		const trimmedPrompt = draft.prompt.trim()
		const input: CreateItemInput = {
			kind: 'solve',
			...(trimmedTitle ? { title: trimmedTitle } : {}),
			...(trimmedPrompt ? { prompt: trimmedPrompt } : {}),
		}
		setSubmitting(true)
		try {
			const result = await window.helm.daemon.createItem(input)
			if (result.error !== undefined) {
				showToast({ message: 'Create failed', detail: result.error, ttlMs: 6000 })
				return
			}
			const first = Array.isArray(result.data) ? result.data[0] : result.data
			if (first && mounted.current) onCreated(first.id)
		} finally {
			setSubmitting(false)
		}
	}

	return (
		<div className="page-frame new-item-page" aria-busy={busy}>
			<PushHeader title="New item" onBack={onBack} backDisabled={busy} />
			<div className="new-item-composer">
				<div className="new-item-editor">
					<div className="new-item-title-field">
						<FieldLabel htmlFor="new-item-title">Title</FieldLabel>
						<TextInput
							id="new-item-title"
							value={draft.title}
							onChange={title => onDraftChange({ ...draft, title })}
							placeholder="Untitled item"
							className="new-item-title-input"
						/>
					</div>
					<div className="new-item-prompt-field">
						<FieldLabel htmlFor="new-item-prompt">Prompt</FieldLabel>
						<TextArea
							id="new-item-prompt"
							value={draft.prompt}
							onChange={prompt => onDraftChange({ ...draft, prompt })}
							placeholder="Describe the work…"
							rows={8}
							className="new-item-prompt-input"
						/>
					</div>
				</div>
				<div className="action-bar new-item-actions">
					<p className="new-item-setup-note">
						<span className="new-item-requirement">Title, prompt, or both.</span>
						<span>Project setup comes later.</span>
					</p>
					<Btn tone="primary" disabled={!valid} busy={busy} onClick={() => void create()}>
						Add to Queue
					</Btn>
				</div>
			</div>
		</div>
	)
}
