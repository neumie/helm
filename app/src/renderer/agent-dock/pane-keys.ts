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
