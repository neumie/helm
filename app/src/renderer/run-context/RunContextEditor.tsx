import { BlockNoteView } from '@blocknote/ariakit'
import type { Block, PartialBlock } from '@blocknote/core'
import '@blocknote/ariakit/style.css'
import { useCreateBlockNote } from '@blocknote/react'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RunContextEditorApi } from '../../shared'
import type { RunContextDraft, RunContextLoad, SourceTask } from '../../shared-helm'
import { type ShortcutChord, matchesShortcut } from '../../shortcuts'
import { ActivityIndicator } from '../activity-indicator'
import { Btn } from '../sidebar/ui'

declare global {
	interface Window {
		runContextEditor: RunContextEditorApi
	}
}

function EditorDialog({
	labelledBy,
	onCancel,
	children,
}: { labelledBy: string; onCancel: () => void; children: ReactNode }) {
	const ref = useRef<HTMLDialogElement>(null)
	useEffect(() => {
		const dialog = ref.current
		if (dialog && !dialog.open) dialog.showModal()
		return () => {
			if (dialog?.open) dialog.close()
		}
	}, [])
	return (
		<dialog
			ref={ref}
			className="run-context-dialog"
			aria-labelledby={labelledBy}
			onCancel={event => {
				event.preventDefault()
				onCancel()
			}}
		>
			{children}
		</dialog>
	)
}

function paragraphs(text: string): PartialBlock[] {
	return text
		.split(/\n\s*\n/)
		.map(part => part.trim())
		.filter(Boolean)
		.map(content => ({ type: 'paragraph', content }))
}

function contextTimestamp(value: string): string {
	const date = new Date(value)
	if (Number.isNaN(date.getTime())) return value
	return new Intl.DateTimeFormat('en', {
		month: 'short',
		day: 'numeric',
		hour: 'numeric',
		minute: '2-digit',
	}).format(date)
}

export function sourceToRunContextBlocks(source: SourceTask): PartialBlock[] {
	const blocks: PartialBlock[] = []
	const descriptionBlocks = source.descriptionBlocks ?? []
	if (descriptionBlocks.length > 0 || source.description?.trim()) {
		blocks.push({ type: 'heading', props: { level: 2 }, content: 'Description' })
		if (descriptionBlocks.length > 0) {
			for (const block of descriptionBlocks) {
				if (block.type === 'image') {
					blocks.push({
						type: 'image',
						props: { url: block.url, caption: block.name ?? '', name: block.name ?? '' },
					})
				} else if (block.heading) {
					blocks.push({
						type: 'heading',
						props: { level: Math.min(3, Math.max(1, block.heading)) as 1 | 2 | 3 },
						content: block.text,
					})
				} else {
					blocks.push(...paragraphs(block.text))
				}
			}
		} else if (source.description) {
			blocks.push(...paragraphs(source.description))
		}
	}
	if (source.comments?.length) {
		blocks.push({ type: 'heading', props: { level: 2 }, content: 'Comments' })
		for (const comment of source.comments) {
			blocks.push({
				type: 'heading',
				props: { level: 3 },
				content: `${comment.author} · ${contextTimestamp(comment.createdAt)}`,
			})
			blocks.push(...paragraphs(comment.body || '(no text)'))
		}
	}
	if (blocks.length === 0) blocks.push({ type: 'paragraph', content: '' })
	return blocks
}

function editorBlocks(blocks: Array<Record<string, unknown>>): PartialBlock[] {
	return blocks.length > 0 ? (blocks as unknown as PartialBlock[]) : [{ type: 'paragraph', content: '' }]
}

function serializableBlocks(blocks: Block[]): Array<Record<string, unknown>> {
	return JSON.parse(JSON.stringify(blocks)) as Array<Record<string, unknown>>
}

export interface RunContextEditorProps {
	loaded: RunContextLoad
	onReload: (next: RunContextLoad) => void
}

export function RunContextEditor({ loaded, onReload }: RunContextEditorProps) {
	const initialContent = useMemo(
		() => (loaded.document ? editorBlocks(loaded.document.blocks) : sourceToRunContextBlocks(loaded.source)),
		[loaded],
	)
	const editor = useCreateBlockNote({ initialContent })
	const locked = loaded.item.status === 'running'
	const [revision, setRevision] = useState(loaded.revision)
	const [dirty, setDirty] = useState(false)
	const dirtyRef = useRef(false)
	dirtyRef.current = dirty
	const [busy, setBusy] = useState<'save' | 'reset' | 'reload' | null>(null)
	const [message, setMessage] = useState(loaded.document ? 'Saved custom context' : 'Using source context')
	const [error, setError] = useState<string | null>(null)
	const [conflict, setConflict] = useState(false)
	const [confirmReset, setConfirmReset] = useState(false)
	const [confirmClose, setConfirmClose] = useState(false)
	const [saveBindings, setSaveBindings] = useState<ShortcutChord[]>(() =>
		window.runContextEditor.saveBindings.map(binding => ({ ...binding })),
	)

	const markDirty = () => {
		if (dirty || locked) return
		dirtyRef.current = true
		setDirty(true)
		setMessage('Unsaved changes')
		window.runContextEditor.setDirty(true)
	}

	const save = useCallback(async (): Promise<boolean> => {
		if (busy || locked) return false
		setBusy('save')
		setError(null)
		const blocks = editor.document
		const markdown = editor.blocksToMarkdownLossy(blocks)
		const document: RunContextDraft = {
			version: 1,
			blocks: serializableBlocks(blocks),
			markdown,
		}
		const result = await window.runContextEditor.save(revision, document)
		setBusy(null)
		if (result.error !== undefined) {
			setError(result.error)
			setConflict(result.status === 409)
			return false
		}
		setRevision(result.data.revision)
		dirtyRef.current = false
		setDirty(false)
		setConflict(false)
		setMessage('Saved')
		window.runContextEditor.setDirty(false)
		return true
	}, [busy, editor, locked, revision])

	const reload = async () => {
		setBusy('reload')
		setError(null)
		const result = await window.runContextEditor.load()
		setBusy(null)
		if (result.error !== undefined) {
			setError(result.error)
			return
		}
		dirtyRef.current = false
		window.runContextEditor.setDirty(false)
		onReload(result.data)
	}

	const reset = async () => {
		setBusy('reset')
		setError(null)
		const result = await window.runContextEditor.reset(revision)
		setBusy(null)
		setConfirmReset(false)
		if (result.error !== undefined) {
			setError(result.error)
			setConflict(result.status === 409)
			return
		}
		dirtyRef.current = false
		window.runContextEditor.setDirty(false)
		onReload({ ...loaded, source: result.data.source, document: null, revision: result.data.revision })
	}

	useEffect(() => {
		const unsubscribe = window.runContextEditor.onCloseRequested(() => {
			if (dirty) {
				setConfirmReset(false)
				setConfirmClose(true)
			} else window.runContextEditor.close(false)
		})
		return unsubscribe
	}, [dirty])

	useEffect(() => {
		if (confirmClose && !dirty && busy === null) window.runContextEditor.close(true)
	}, [busy, confirmClose, dirty])

	// The auxiliary window can outlive a run transition. Refresh its narrow
	// resource when focus returns so running/non-running lock state stays true,
	// but never replace an unsaved editor snapshot.
	useEffect(() => {
		let active = true
		const refreshOnFocus = () => {
			if (dirtyRef.current || busy) return
			void window.runContextEditor.load().then(result => {
				// Focus-load may finish after the first edit event. The ref changes
				// synchronously in markDirty, before React commits state.
				if (!active || dirtyRef.current || result.error !== undefined) return
				if (result.data.item.status !== loaded.item.status || result.data.revision !== revision) onReload(result.data)
			})
		}
		window.addEventListener('focus', refreshOnFocus)
		return () => {
			active = false
			window.removeEventListener('focus', refreshOnFocus)
		}
	}, [busy, loaded.item.status, onReload, revision])

	useEffect(() => window.runContextEditor.onSaveBindingsChanged(setSaveBindings), [])

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.repeat || event.isComposing || event.key === 'Dead' || event.key === 'Process') return
			if (!saveBindings.some(binding => matchesShortcut(event, binding, window.runContextEditor.platform))) return
			event.preventDefault()
			void save()
		}
		window.addEventListener('keydown', onKeyDown)
		return () => window.removeEventListener('keydown', onKeyDown)
	}, [saveBindings, save])

	const cancelClose = () => {
		setConfirmClose(false)
		window.runContextEditor.cancelClose()
	}

	const busyMessage = busy === 'save' ? 'Saving' : busy === 'reset' ? 'Resetting to source' : 'Loading latest'
	const attachments = loaded.source.attachments ?? []
	return (
		<div className="run-context-shell" aria-busy={busy !== null}>
			<header className="run-context-header">
				<div className="run-context-heading">
					<div className="run-context-kicker">{loaded.item.projectSlug ?? 'Unassigned'}</div>
					<h1>{loaded.item.title}</h1>
				</div>
				<output className="run-context-save-state" aria-live="polite">
					{busy && <ActivityIndicator label={busyMessage} />}
					<span>{busy ? busyMessage : message}</span>
				</output>
				<div className="run-context-actions">
					<Btn tone="ghost" sm disabled={busy !== null || locked} onClick={() => setConfirmReset(true)}>
						Reset to source
					</Btn>
					<Btn
						tone="primary"
						sm
						disabled={!dirty || busy !== null || locked}
						busy={busy === 'save'}
						onClick={() => void save()}
					>
						Save context
					</Btn>
				</div>
			</header>

			<div className="run-context-notice">
				{locked
					? 'This run is active, so its context is locked. Edit it after the run finishes.'
					: 'Edit exactly what planning and future runs receive. Deleting content here never changes the source task.'}
			</div>
			{error && (
				<div className={`run-context-banner${conflict ? ' is-conflict' : ''}`} role="alert">
					<div>
						<strong>{conflict ? 'Context changed elsewhere' : 'Could not save context'}</strong>
						<span>{error}</span>
					</div>
					{conflict && (
						<Btn tone="quiet" sm busy={busy === 'reload'} onClick={() => void reload()}>
							Reload latest
						</Btn>
					)}
				</div>
			)}

			<main className="run-context-main">
				<div className="run-context-editor" aria-label="Run context document">
					<BlockNoteView editor={editor} theme="dark" editable={!locked && busy === null} onChange={markDirty} />
				</div>
				<aside className="run-context-source" aria-label="Protected source context">
					<h2>Always included</h2>
					<dl>
						<div>
							<dt>Task</dt>
							<dd>{loaded.source.title}</dd>
						</div>
					</dl>
					{attachments.length > 0 && (
						<>
							<h2>Source attachments</h2>
							<ul>
								{attachments.map(attachment => (
									<li key={attachment.url}>{attachment.name}</li>
								))}
							</ul>
						</>
					)}
				</aside>
			</main>

			{confirmReset && (
				<EditorDialog labelledBy="reset-title" onCancel={() => setConfirmReset(false)}>
					<h2 id="reset-title">Reset to latest source?</h2>
					<p>Your custom document will be discarded. The source task itself is never changed.</p>
					<div className="run-context-dialog-actions">
						<Btn tone="quiet" onClick={() => setConfirmReset(false)}>
							Keep editing
						</Btn>
						<Btn tone="danger" busy={busy === 'reset'} onClick={() => void reset()}>
							Reset context
						</Btn>
					</div>
				</EditorDialog>
			)}

			{confirmClose && (
				<EditorDialog labelledBy="close-title" onCancel={cancelClose}>
					<h2 id="close-title">Save before closing?</h2>
					<p>Your source task is safe, but this run-context draft has unsaved changes.</p>
					<div className="run-context-dialog-actions">
						<Btn tone="quiet" disabled={busy !== null} onClick={cancelClose}>
							Keep editing
						</Btn>
						<Btn tone="danger" disabled={busy !== null} onClick={() => window.runContextEditor.close(true)}>
							Discard
						</Btn>
						<Btn
							tone="primary"
							disabled={busy !== null}
							busy={busy === 'save'}
							onClick={() => void save().then(saved => saved && window.runContextEditor.close(true))}
						>
							Save and close
						</Btn>
					</div>
				</EditorDialog>
			)}
		</div>
	)
}
