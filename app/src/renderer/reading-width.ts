import { type ShortcutChord, matchesShortcut, shortcutDisplay } from '../shortcuts'

/**
 * Reading width layouts for long-form document surfaces; values and CSS live in
 * reading-width.css. Fixed layouts are design variants; 'narrow' | 'wide' |
 * 'full' are the reader's choice (variant C).
 */
export type ReadingWidthLayout = 'measure' | 'fluid' | 'fit' | ReadingWidthChoice
export type ReadingWidthChoice = 'narrow' | 'wide' | 'full'

export const READING_WIDTH_CHOICES: readonly { value: ReadingWidthChoice; label: string; chord: ShortcutChord }[] = [
	{ value: 'narrow', label: 'Narrow', chord: { code: 'Digit1', alt: true } },
	{ value: 'wide', label: 'Wide', chord: { code: 'Digit2', alt: true } },
	{ value: 'full', label: 'Full', chord: { code: 'Digit3', alt: true } },
]
export const DEFAULT_READING_WIDTH: ReadingWidthChoice = 'wide'

/**
 * One app-wide choice, not per document or window: width answers "how wide is
 * my screen and how do I like to read", which every document shares.
 */
const STORAGE_KEY = 'helm.reading.width'

export function readStoredReadingWidth(): ReadingWidthChoice | null {
	try {
		const value = localStorage.getItem(STORAGE_KEY)
		return READING_WIDTH_CHOICES.some(choice => choice.value === value) ? (value as ReadingWidthChoice) : null
	} catch {
		return null
	}
}

export function storeReadingWidth(value: ReadingWidthChoice): void {
	try {
		localStorage.setItem(STORAGE_KEY, value)
	} catch {
		/* The choice still applies to this window. */
	}
}

function platform(): NodeJS.Platform {
	return typeof navigator !== 'undefined' && /Mac/.test(navigator.userAgent) ? 'darwin' : 'linux'
}

export function readingWidthShortcutLabel(value: ReadingWidthChoice): string {
	const choice = READING_WIDTH_CHOICES.find(choice => choice.value === value)
	return choice ? shortcutDisplay(choice.chord, platform()) : ''
}

export function readingWidthForShortcut(event: KeyboardEvent): ReadingWidthChoice | null {
	return READING_WIDTH_CHOICES.find(choice => matchesShortcut(event, choice.chord, platform()))?.value ?? null
}
