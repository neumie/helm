import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { parseReviewRequest } from '../src/document-review/request-admission.js'
import {
	decodeScreenshots,
	discardScreenshots,
	reviewFollowUpContent,
	stageScreenshots,
} from '../src/document-review/screenshot-files.js'
import {
	REVIEW_SCREENSHOT_DIRECTORY,
	REVIEW_SCREENSHOT_INSTRUCTION,
	appendScreenshotPrompt,
	inspectScreenshot,
	parseScreenshotPrompt,
	splitScreenshotPayload,
} from '../src/document-review/screenshot-format.js'
import { REVIEW_PROMPT_UNITS } from '../src/document-review/types.js'

const PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
	'base64',
)
const JPEG = Buffer.from(
	'/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAkGBxISEhUQEhIVFhUVFRUWFxUVFRUWFRUWFRUWFhUWFRUYHSggGBolGxUVITEhJSkrLi4uFx8zODMtNygtLisBCgoKDg0OGhAQGy0lHyUtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLf/AABEIAQABAAMBIgACEQEDEQH/xAAbAAACAwEBAQAAAAAAAAAAAAADBAIFBgEBC//EABQBAQAAAAAAAAAAAAAAAAAAAAD/xAAVAQEBAAAAAAAAAAAAAAAAAAAAAf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJQA/9k=',
	'base64',
)

test('screenshot paste accepts a real PNG and JPEG and refuses other bytes', () => {
	assert.equal(inspectScreenshot(PNG), 'image/png')
	assert.equal(inspectScreenshot(JPEG), 'image/jpeg')
	assert.throws(() => inspectScreenshot(Buffer.from('not an image')), /PNG or JPEG/)
})

test('screenshot bytes stay off the strict review request', () => {
	const raw = {
		id: '00000000-0000-4000-8000-000000000001',
		documentId: '00000000-0000-4000-8000-000000000002',
		sessionId: 'review:00000000-0000-4000-8000-000000000003',
		owner: '00000000-0000-4000-8000-000000000004',
		revision: 'a'.repeat(64),
		intent: 'discuss',
		instruction: 'Look here',
		passage: null,
		screenshots: [{ mediaType: 'image/png', dataBase64: PNG.toString('base64') }],
	}
	const split = splitScreenshotPayload(raw)
	assert.equal('screenshots' in (split.request as object), false)
	assert.equal(split.screenshots.length, 1)
	assert.throws(() => parseReviewRequest(raw), /Invalid or oversized/)
	const decoded = decodeScreenshots(split.screenshots)
	assert.equal(decoded[0]?.mediaType, 'image/png')
	assert.equal(decoded[0]?.bytes.length, PNG.length)
})

test('staged screenshots are owner-private files the follow-up can see, and arbitrary paths are not', async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'helm-shots-')))
	const directory = join(root, REVIEW_SCREENSHOT_DIRECTORY)
	try {
		const staged = await stageScreenshots(directory, [{ mediaType: 'image/png', bytes: PNG }])
		const prompt = appendScreenshotPrompt('Discuss the document.', staged)
		assert.match(prompt, /evidence of what the operator saw/)
		assert.equal(parseScreenshotPrompt(prompt)[0]?.path, staged[0]?.path)
		const content = reviewFollowUpContent(prompt)
		assert.ok(Array.isArray(content))
		assert.equal(content[0]?.type, 'text')
		assert.equal(content[1]?.type, 'image')
		if (content[1]?.type === 'image') assert.equal(content[1].data, PNG.toString('base64'))
		const forged = appendScreenshotPrompt('Discuss the document.', [
			{ mediaType: 'image/png', bytes: 12, path: '/etc/passwd' },
		])
		assert.deepEqual(reviewFollowUpContent(forged), forged)
		await discardScreenshots(staged)
		await assert.rejects(stat(staged[0]?.path ?? ''))
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test('an image-only instruction is explicit and an oversized prompt is refused before delivery', () => {
	assert.equal(REVIEW_SCREENSHOT_INSTRUCTION, 'Look at the attached screenshots.')
	const staged = [
		{
			mediaType: 'image/png' as const,
			bytes: PNG.length,
			path: '/tmp/document-review-screenshots/shot-00000000-0000-4000-8000-000000000099.png',
		},
	]
	assert.throws(() => appendScreenshotPrompt('x'.repeat(REVIEW_PROMPT_UNITS - 10), staged), /too large/)
})
