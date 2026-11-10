import { resolve } from 'node:path'
import { defaultReviewRoot, helloReview, viewReview } from '../document-review/client.js'
import { REVIEW_VIEW_FILES, REVIEW_VIEW_RATE } from '../document-review/protocol.js'
import type { ReviewViewResult } from '../document-review/protocol.js'
import { runEditCli } from './edit.js'

export const OPEN_HELP = `Usage: helm open FILE…
       helm open --listen FILE [--timeout SECONDS] [--agent NAME] [--workspace DIR] [--label TEXT]

Show files read-only in the Helm desktop and return at once. Nothing is
written, nothing is loaded from the network and no agent is involved.
This version shows Markdown, plain text and logs, code (about 40 languages,
.jsx/.tsx as source, never run), JSON, JSON Lines, YAML and TOML as a tree,
and pictures: PNG, JPEG, GIF, WebP, AVIF, BMP, ICO, SVG (as an image, never
run) and HEIC (converted to PNG by macOS sips). A picture's size limit
(150 MP) is checked in the window, so that refusal shows there.
Any readable file works, inside or outside a Git repository; Helm's own
private files are refused. Nothing from the file comes back to the caller.

  helm open notes.md other.md     each file opens in its own window
  helm open --json notes.md       print {opened:[…], refused:[…]} as JSON
  helm open --listen spec.md      the same as helm edit spec.md: open it for
                                  feedback in THIS running agent conversation

Windows opened from here appear without taking focus. A refused file does not
stop the others; each refusal is one line on stderr and the exit code is 1.
The Helm desktop must be running (an updated one: older desktops say so).
`

const EDIT_OPTIONS = new Set(['--timeout', '--agent', '--workspace', '--label'])
/** The control wire's path bound (protocol.ts `path`). */
const MAX_PATH = 2048
const control = (code: number) => code < 32 || (code >= 127 && code <= 159)
/** Same rule as the wire's `noControls`. */
const hasControl = (text: string) => [...text].some(char => control(char.charCodeAt(0)))
const oneLine = (text: string) => text.replace(/[\r\n]+/g, ' ').trim()
/** A file name safe for one stderr line: control characters shown as `?`, long names cut in the middle. */
const shown = (file: string) => {
	const name = [...file].map(char => (control(char.charCodeAt(0)) ? '?' : char)).join('')
	return name.length > 120 ? `${name.slice(0, 58)}…${name.slice(-58)}` : name
}

export interface OpenCliDependencies {
	root: string
	stdout(text: string): Promise<void>
	stderr(text: string): void
	sleep(ms: number): Promise<void>
	edit(args: string[]): Promise<void>
}
const write = (text: string) =>
	new Promise<void>((done, fail) => process.stdout.write(text, error => (error ? fail(error) : done())))
const defaults = (): OpenCliDependencies => ({
	root: defaultReviewRoot(),
	stdout: write,
	stderr: text => process.stderr.write(text),
	sleep: ms => new Promise(done => setTimeout(done, ms)),
	edit: runEditCli,
})

export interface OpenArguments {
	files: string[]
	listen: boolean
	json: boolean
	help: boolean
	editOptions: string[]
}
/** Pure argument parsing; every mistake is refused before the desktop is contacted. */
export function parseOpenArguments(args: string[]): OpenArguments {
	const parsed: OpenArguments = { files: [], listen: false, json: false, help: false, editOptions: [] }
	const seen = new Set<string>()
	for (let index = 0; index < args.length; index++) {
		const arg = args[index] as string
		if (arg === '--help' || arg === '-h' || (arg === 'help' && index === 0 && args.length === 1)) parsed.help = true
		else if (arg === '--listen' || arg === '--json') {
			if (seen.has(arg)) throw new Error(`Repeated option: ${arg}`)
			seen.add(arg)
			if (arg === '--listen') parsed.listen = true
			else parsed.json = true
		} else if (EDIT_OPTIONS.has(arg)) {
			const value = args[++index]
			if (value === undefined || !value || value.startsWith('--') || seen.has(arg))
				throw new Error(`Expected one value for ${arg}`)
			seen.add(arg)
			parsed.editOptions.push(arg, value)
		} else if (arg === '-') throw new Error('helm open does not read standard input; pass a file path.')
		else if (arg === '--reveal' || arg === '--default-app')
			throw new Error(`${arg} is not available yet; helm open shows the file in a Helm window.`)
		else if (arg.startsWith('-')) throw new Error(`Unknown option for helm open: ${arg}. Run helm open help.`)
		else parsed.files.push(arg)
	}
	if (parsed.help) return parsed
	if (!parsed.files.length) throw new Error('Name at least one file: helm open FILE…')
	if (parsed.listen && parsed.files.length !== 1)
		throw new Error('helm open --listen takes exactly one file; nothing was opened.')
	if (!parsed.listen && parsed.editOptions.length)
		throw new Error(`${parsed.editOptions[0]} belongs to helm open --listen; nothing was opened.`)
	if (parsed.files.length > REVIEW_VIEW_FILES)
		throw new Error(`helm open opens at most ${REVIEW_VIEW_FILES} files at once; nothing was opened.`)
	return parsed
}

/** Runs `helm open`; resolves with the process exit code. */
export async function runOpenCli(args: string[], deps: OpenCliDependencies = defaults()): Promise<number> {
	const parsed = parseOpenArguments(args)
	if (parsed.help) {
		await deps.stdout(OPEN_HELP)
		return 0
	}
	if (parsed.listen) {
		// Byte-identical to helm edit FILE, which itself learns the host's protocol first. --json is implied.
		await deps.edit([parsed.files[0] as string, ...parsed.editOptions])
		return 0
	}
	const hello = await helloReview(deps.root)
	if (hello.protocol < 2) {
		deps.stderr('Update the Helm desktop to use helm open. Nothing was opened.\n')
		return 1
	}
	const result: ReviewViewResult = { opened: [], refused: [] }
	// The wire carries paths of at most 2048 characters with no control characters. Any other path is refused here,
	// by name, and never sent: one odd name must not fail the whole command.
	const files: string[] = []
	for (const file of parsed.files.map(file => resolve(file))) {
		if (file.length <= MAX_PATH && !hasControl(file)) files.push(file)
		else
			result.refused.push({
				file,
				reason: `${shown(file)}: ${file.length > MAX_PATH ? `the path is longer than ${MAX_PATH} characters` : 'the path has control characters'}; helm open can't send it to Helm.`,
			})
	}
	// The host opens at most REVIEW_VIEW_RATE files per second. The next batch waits a second after the previous
	// answer arrived (the host counted those files before answering), so none is refused for the rate.
	let last = 0
	let failure: string | null = null
	for (let start = 0; start < files.length; start += REVIEW_VIEW_RATE) {
		const chunk = files.slice(start, start + REVIEW_VIEW_RATE)
		if (failure) {
			// A batch the desktop refused or never confirmed stops the rest; what opened before stays reported.
			for (const file of chunk) result.refused.push({ file, reason: `${shown(file)}: not sent (${failure}).` })
			continue
		}
		const wait = last ? 1000 - (Date.now() - last) : 0
		if (wait > 0) await deps.sleep(wait + 20)
		try {
			const batch = await viewReview(chunk, deps.root)
			result.opened.push(...batch.opened)
			result.refused.push(...batch.refused)
		} catch (error) {
			failure = oneLine(error instanceof Error ? error.message : String(error))
			for (const file of chunk) result.refused.push({ file, reason: `${shown(file)}: ${failure}` })
		}
		last = Date.now()
	}
	if (parsed.json) await deps.stdout(`${JSON.stringify(result)}\n`)
	// One line per refusal: the host's reason names the file and the way out.
	for (const refusal of result.refused) deps.stderr(`${refusal.reason.replace(/[\r\n]+/g, ' ')}\n`)
	return result.refused.length ? 1 : 0
}
