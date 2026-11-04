// Agent dock pane keys (design §3.24): the pane-level key handler a body binds while it is
// mounted, and the predicates it is built from (digits pick, ⌘Enter / Enter submit, ⌘⌫ acks, a
// stray typed key disarms). Typing in a field never picks or submits through these.
import { type KeyboardEvent, type MutableRefObject, useLayoutEffect, useRef } from 'react'

/** The word for the submit modifier in key hints: `cmd` on macOS (Menlo draws ⌘ small), `ctrl` elsewhere. */
export type DockModKey = 'cmd' | 'ctrl'

/** Pane-level keys a body handles (digits, Enter). Returns true when it consumed the event. */
export type DetailKeys = (event: KeyboardEvent<HTMLElement>) => boolean

/** Typing in a field never picks options or submits through the pane keys. */
export const isTextField = (target: EventTarget | null): boolean =>
	target instanceof Element && target.closest('input, textarea, [contenteditable="true"]') !== null

/** Binds a body's key handler for the pane while it is mounted. */
export function useKeys(keys: MutableRefObject<DetailKeys | null>, handler: DetailKeys): void {
	const latest = useRef(handler)
	latest.current = handler
	useLayoutEffect(() => {
		const bound: DetailKeys = event => latest.current(event)
		keys.current = bound
		return () => {
			if (keys.current === bound) keys.current = null
		}
	}, [keys])
}

export const noModifiers = (event: KeyboardEvent<HTMLElement>): boolean =>
	!event.metaKey && !event.ctrlKey && !event.altKey

/** 1–9 from a key event, or null. */
export const digitOf = (event: KeyboardEvent<HTMLElement>): number | null => {
	if (!noModifiers(event) || isTextField(event.target)) return null
	const digit = Number(event.key)
	return /^[1-9]$/.test(event.key) && Number.isInteger(digit) ? digit : null
}

/** Enter on the pane itself or its scroll body (buttons and fields keep their own Enter). */
const isBareEnter = (event: KeyboardEvent<HTMLElement>): boolean =>
	event.key === 'Enter' &&
	!event.shiftKey &&
	noModifiers(event) &&
	!event.nativeEvent.isComposing &&
	!isTextField(event.target) &&
	(event.target === event.currentTarget || (event.target as Element).classList?.contains('agent-dock-pane-scroll'))

/** ⌘Enter (Ctrl+Enter off macOS): submit from anywhere in the pane, fields and choices included. */
const isModEnter = (event: KeyboardEvent<HTMLElement>): boolean =>
	event.key === 'Enter' &&
	(event.metaKey || event.ctrlKey) &&
	!event.altKey &&
	!event.shiftKey &&
	!event.nativeEvent.isComposing

/** A printable key (shift allowed) outside a text field; Space stays the pane's page key. */
export const isPrintable = (event: KeyboardEvent<HTMLElement>): boolean =>
	event.key.length === 1 &&
	event.key !== ' ' &&
	noModifiers(event) &&
	!event.nativeEvent.isComposing &&
	!isTextField(event.target)

/** A printable key that is not a pick (1–9): Jakub is typing, but not into a field. */
export const isStrayKey = (event: KeyboardEvent<HTMLElement>): boolean =>
	isPrintable(event) && !/^[1-9]$/.test(event.key)

/**
 * Submit keys: ⌘Enter anywhere in the pane and, where `bareEnter`, Enter on the pane or its body.
 * A held key never submits.
 */
export function submitKeys(
	event: KeyboardEvent<HTMLElement>,
	{ bareEnter, submit }: { bareEnter: boolean; submit(): void },
): boolean {
	if (isModEnter(event) || (bareEnter && isBareEnter(event))) {
		if (!event.repeat) submit()
		return true
	}
	return false
}

/**
 * ⌘⌫ (Ctrl+Backspace off macOS): Ack, from anywhere in the pane. The caller still leaves it to a
 * text field that has text in it (`keepsEditKey`).
 */
export const isAckKey = (event: KeyboardEvent<HTMLElement>, mod: DockModKey): boolean =>
	event.key === 'Backspace' &&
	(mod === 'cmd' ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey) &&
	!event.altKey &&
	!event.shiftKey &&
	!event.nativeEvent.isComposing

/** A text field with text in it keeps ⌘⌫ (Ctrl+Backspace) for editing; an empty one gives it to Ack. */
export const keepsEditKey = (target: EventTarget | null): boolean => {
	const field = target instanceof Element ? target.closest('input, textarea, [contenteditable="true"]') : null
	if (!field) return false
	const text =
		field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement ? field.value : (field.textContent ?? '')
	return text !== ''
}

export const modShortcut = (mod: DockModKey): string => (mod === 'cmd' ? 'Meta+Enter' : 'Control+Enter')

/** The go-to-dock key: as the row shows it (one notation with the hints) and as aria-keyshortcuts names it. */
export const dockShortcut = (mod: DockModKey): { label: string; aria: string } =>
	mod === 'cmd' ? { label: '⌘⇧J', aria: 'Meta+Shift+J' } : { label: 'Ctrl+Shift+J', aria: 'Control+Shift+J' }

/** The submit key as the hints show it: one notation with the row's `⌘⇧J` (`Ctrl+Enter` off macOS). */
export const modHint = (mod: DockModKey): string => (mod === 'cmd' ? '⌘↵' : 'Ctrl+Enter')

/** The Ack key: as the hints show it and as aria-keyshortcuts names it. */
export const ackShortcut = (mod: DockModKey): { label: string; aria: string } =>
	mod === 'cmd' ? { label: '⌘⌫', aria: 'Meta+Backspace' } : { label: 'Ctrl+Backspace', aria: 'Control+Backspace' }

/**
 * The shown body's choice stop — the row a roving list would focus (last focused, else picked, else
 * the first) — while its choices are live; null for bodies without them (turns, receipts).
 */
export const choiceStop = (pane: HTMLElement): HTMLButtonElement | null =>
	pane.querySelector<HTMLButtonElement>('.agent-dock-choice[tabindex="0"]:not(:disabled)')

/**
 * The pane body clips its content, so there is something to read below or above. Only its bottom
 * padding cut off (a body a few px past its locked height, every line in view) does not count: ↑ ↓
 * would scroll by nothing visible instead of stepping items, and the scroll hint would promise more.
 */
export const overflows = (body: HTMLElement): boolean => {
	const padding = Number.parseFloat(getComputedStyle(body).paddingBottom)
	return body.scrollHeight - body.clientHeight > (Number.isFinite(padding) ? padding : 0) + 1
}

/** What a key asks of the pane's scroll body. */
export type BodyScroll = 'line-up' | 'line-down' | 'page-up' | 'page-down' | 'top' | 'bottom'

const emptyField = (field: Element): boolean =>
	field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement
		? field.value === ''
		: (field.textContent ?? '') === ''

/**
 * The scroll a key asks of the pane's body from where it was pressed, or null when the key keeps its
 * own meaning. `scrolls`: the body overflows; `choices`: it has live choices (↑ ↓ go to them instead).
 * - The pane, its body, a message link, ‹ ›, esc and the footer keys: Page keys and Space / Shift+Space
 *   page, Home / End jump, ↑ ↓ scroll a line step (only while the body overflows with no live choices,
 *   else they step items as before). A button keeps Space (and everything) while the body fits; Enter
 *   always presses it.
 * - A choice or question tab keeps its arrows, Home / End and Space; Page keys page from it.
 * - A text field keeps its keys while it has text; an empty one (nothing to edit) gives Page keys and,
 *   with no live choices, ↑ ↓ to the body. Space types.
 */
export function bodyScrollKey(
	event: KeyboardEvent<HTMLElement>,
	{ scrolls, choices }: { scrolls: boolean; choices: boolean },
): BodyScroll | null {
	if (!noModifiers(event) || event.nativeEvent.isComposing) return null
	const { key, shiftKey: shift } = event
	const page: BodyScroll | null = key === 'PageDown' ? 'page-down' : key === 'PageUp' ? 'page-up' : null
	const line: BodyScroll | null =
		scrolls && !choices ? (key === 'ArrowDown' ? 'line-down' : key === 'ArrowUp' ? 'line-up' : null) : null
	const target = event.target instanceof Element ? event.target : null
	if (!target) return null
	const field = target.closest('input, textarea, [contenteditable="true"]')
	if (field) return shift || !emptyField(field) ? null : (page ?? line)
	if (target.closest('.agent-dock-choice, [role="tab"]')) return shift ? null : page
	if (target.closest('button') && !scrolls) return null
	if (key === ' ') return shift ? 'page-up' : 'page-down'
	if (shift) return null
	return page ?? (key === 'Home' ? 'top' : key === 'End' ? 'bottom' : line)
}

/** Scrolls the body (instantly, focus untouched): a line step is three lines, a page its height less 32px. */
export function scrollBody(body: HTMLElement, how: BodyScroll): void {
	const lineHeight = Number.parseFloat(getComputedStyle(body).lineHeight)
	const line = Math.round(3 * (Number.isFinite(lineHeight) ? lineHeight : 18))
	const page = Math.max(16, body.clientHeight - 32)
	if (how === 'top') body.scrollTop = 0
	else if (how === 'bottom') body.scrollTop = body.scrollHeight
	else if (how === 'line-up') body.scrollTop -= line
	else if (how === 'line-down') body.scrollTop += line
	else body.scrollTop += how === 'page-up' ? -page : page
}
