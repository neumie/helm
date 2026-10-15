import { randomUUID } from 'node:crypto'
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import { lstat, open, readdir, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { privateDirectory } from './private-state.js'
import {
	REVIEW_SCREENSHOT_BYTES,
	REVIEW_SCREENSHOT_DIRECTORY,
	REVIEW_SCREENSHOT_LIMIT,
	REVIEW_SCREENSHOT_TOTAL_BYTES,
	inspectScreenshot,
	isScreenshotFileName,
	parseScreenshotPrompt,
	screenshotFileName,
} from './screenshot-format.js'
import type { DecodedScreenshot, ReviewScreenshotInput, StagedScreenshot } from './screenshot-format.js'

const MAX_AGE_MS = 6 * 60 * 60 * 1000
const MAX_DIRECTORY_BYTES = 64 * 1024 * 1024
const owned = (stat: { uid: number; mode: number }) =>
	process.getuid !== undefined && stat.uid === process.getuid() && (stat.mode & 0o077) === 0

export function decodeScreenshots(inputs: ReviewScreenshotInput[]): DecodedScreenshot[] {
	if (inputs.length > REVIEW_SCREENSHOT_LIMIT) throw new Error('Attach at most four screenshots. Nothing was sent.')
	let total = 0
	return inputs.map(input => {
		const bytes = decodeBase64(input.dataBase64)
		const mediaType = inspectScreenshot(bytes)
		if (mediaType !== input.mediaType)
			throw new Error('Paste a PNG or JPEG screenshot of at most 4 MB. Nothing was sent.')
		total += bytes.length
		if (total > REVIEW_SCREENSHOT_TOTAL_BYTES) throw new Error('Screenshots are too large together. Nothing was sent.')
		return { mediaType, bytes }
	})
}

/** Owner-private files outside the repository. Bytes never enter the review wire or journal. */
export async function stageScreenshots(
	directory: string,
	shots: readonly DecodedScreenshot[],
): Promise<StagedScreenshot[]> {
	if (shots.length === 0) return []
	const root = await privateDirectory(directory)
	if (basename(root) !== REVIEW_SCREENSHOT_DIRECTORY)
		throw new Error('Could not keep the screenshot for your agent. Nothing was sent.')
	await sweep(root)
	const staged: StagedScreenshot[] = []
	try {
		for (const shot of shots) {
			const name = screenshotFileName(randomUUID(), shot.mediaType)
			const path = join(root, name)
			const file = await open(
				path,
				constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
				0o600,
			)
			try {
				await file.writeFile(shot.bytes)
				await file.sync()
			} finally {
				await file.close()
			}
			const stat = await lstat(path)
			if (
				!stat.isFile() ||
				stat.isSymbolicLink() ||
				stat.nlink !== 1 ||
				!owned(stat) ||
				stat.size !== shot.bytes.length
			)
				throw new Error('Could not keep the screenshot for your agent. Nothing was sent.')
			staged.push({ mediaType: shot.mediaType, bytes: shot.bytes.length, path })
		}
		return staged
	} catch (error) {
		await discardScreenshots(staged)
		throw error
	}
}

export async function discardScreenshots(staged: readonly StagedScreenshot[]): Promise<void> {
	for (const shot of staged) {
		if (basename(dirname(shot.path)) !== REVIEW_SCREENSHOT_DIRECTORY || !isScreenshotFileName(basename(shot.path)))
			continue
		await unlink(shot.path).catch(() => undefined)
	}
}

/** Synchronous because Pi follow-up dispatch cannot await. A bad file is omitted, never thrown. */
export function readScreenshotImagesSync(
	prompt: string,
): { type: 'image'; data: string; mimeType: 'image/png' | 'image/jpeg' }[] {
	const images = []
	for (const shot of parseScreenshotPrompt(prompt)) {
		const image = readOne(shot)
		if (image) images.push(image)
	}
	return images
}

export function reviewFollowUpContent(
	prompt: string,
): string | ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[] {
	const images = readScreenshotImagesSync(prompt)
	return images.length === 0 ? prompt : [{ type: 'text', text: prompt }, ...images]
}

function decodeBase64(value: string): Uint8Array {
	const max = Math.ceil(REVIEW_SCREENSHOT_BYTES / 3) * 4
	if (value.length === 0 || value.length > max || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value))
		throw new Error('Paste a PNG or JPEG screenshot of at most 4 MB. Nothing was sent.')
	const bytes = Uint8Array.from(Buffer.from(value, 'base64'))
	if (bytes.length === 0 || bytes.length > REVIEW_SCREENSHOT_BYTES)
		throw new Error('Paste a PNG or JPEG screenshot of at most 4 MB. Nothing was sent.')
	return bytes
}

async function sweep(root: string): Promise<void> {
	const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
	let retained = 0
	const now = Date.now()
	for (const entry of entries) {
		if (!entry.isFile() || entry.isSymbolicLink() || !isScreenshotFileName(entry.name)) continue
		const path = join(root, entry.name)
		const stat = await lstat(path).catch(() => null)
		if (!stat?.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) continue
		if (now - stat.mtimeMs > MAX_AGE_MS) {
			await unlink(path).catch(() => undefined)
			continue
		}
		retained += stat.size
	}
	if (retained > MAX_DIRECTORY_BYTES) throw new Error('Screenshot storage is full. Nothing was sent.')
}

function readOne(shot: StagedScreenshot): { type: 'image'; data: string; mimeType: 'image/png' | 'image/jpeg' } | null {
	if (basename(dirname(shot.path)) !== REVIEW_SCREENSHOT_DIRECTORY || !isScreenshotFileName(basename(shot.path)))
		return null
	let handle: number | null = null
	try {
		const named = lstatSync(shot.path)
		if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || !owned(named) || named.size !== shot.bytes)
			return null
		handle = openSync(shot.path, constants.O_RDONLY | constants.O_NOFOLLOW)
		const stat = fstatSync(handle)
		if (!stat.isFile() || stat.nlink !== 1 || stat.size !== shot.bytes || stat.ino !== named.ino) return null
		const bytes = Buffer.alloc(stat.size)
		let count = 0
		while (count < bytes.length) {
			const read = readSync(handle, bytes, count, bytes.length - count, count)
			if (!read) return null
			count += read
		}
		if (inspectScreenshot(bytes) !== shot.mediaType) return null
		return { type: 'image', data: bytes.toString('base64'), mimeType: shot.mediaType }
	} catch {
		return null
	} finally {
		if (handle !== null) closeSync(handle)
	}
}
