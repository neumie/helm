import type { ProcessedImageResource } from './image-draft.js'

/** Memory-only editor ownership, independent of command admission and full-owner authorization. */
export interface PromptRecovery {
	commandId: string
	rawText: string
	images: ProcessedImageResource[]
	clearedAtToken: symbol
	state: 'awaiting' | 'choice'
}
export interface PromptTransferFailure {
	transferToken: symbol
	message: 'Message was not sent. Image upload failed.'
}
export interface PromptDraft {
	text: string
	images?: ProcessedImageResource[]
	editToken: symbol
	recovery?: PromptRecovery
	transferFailure?: PromptTransferFailure
}
export function editPrompt(draft: PromptDraft, text: string): void {
	draft.text = text
	draft.editToken = Symbol()
}
export function editPromptImages(draft: PromptDraft, images: ProcessedImageResource[]): void {
	draft.images = images
	draft.editToken = Symbol()
}
export function promptHasContent(draft: PromptDraft): boolean {
	return !!draft.text.trim() || !!draft.images?.length
}
/** Call only after the existing synchronous effect admission guards. Moves, never copies, image ownership. */
export function admitPrompt(draft: PromptDraft, commandId: string): boolean {
	if (draft.recovery || !promptHasContent(draft) || draft.text.length > 16384) return false
	const rawText = draft.text
	const images = draft.images ?? []
	draft.text = ''
	draft.images = []
	draft.editToken = Symbol()
	draft.recovery = { commandId, rawText, images, clearedAtToken: draft.editToken, state: 'awaiting' }
	return true
}
export function settlePrompt(draft: PromptDraft, commandId: string, outcome: 'dispatched' | 'rejected'): void {
	const recovery = draft.recovery
	if (!recovery || recovery.commandId !== commandId || recovery.state !== 'awaiting') return
	if (outcome === 'dispatched') {
		for (const image of recovery.images) image.dispose()
		draft.recovery = undefined
	} else if (draft.editToken === recovery.clearedAtToken) {
		draft.text = recovery.rawText
		draft.images = recovery.images
		draft.editToken = Symbol()
		draft.recovery = undefined
	} else {
		recovery.state = 'choice'
	}
}
/** Captured object identity fences stale rendered actions as well as command identity. */
export function choosePrompt(draft: PromptDraft, recovery: PromptRecovery, restore: boolean): boolean {
	if (draft.recovery !== recovery || recovery.state !== 'choice') return false
	if (restore) {
		for (const image of draft.images ?? []) image.dispose()
		draft.text = recovery.rawText
		draft.images = recovery.images
		draft.editToken = Symbol()
	} else {
		for (const image of recovery.images) image.dispose()
	}
	draft.recovery = undefined
	return true
}
export function disposePromptDraft(draft: PromptDraft): void {
	for (const image of draft.images ?? []) image.dispose()
	for (const image of draft.recovery?.images ?? []) image.dispose()
	draft.images = []
	draft.recovery = undefined
	draft.transferFailure = undefined
}
