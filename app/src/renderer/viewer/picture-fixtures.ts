/// <reference path="../open-prototype/vite-env.d.ts" />
// Story/Playwright-only fixtures for picture windows. The bytes are the real fixture files fetched by Vite URL and
// served again from blob: URLs, which stand in for main's helm-viewer://app/file/<token> URLs; a HEIC is served as
// the PNG `sips` really made from it. Everything else is the production DocumentReview window. Never import this
// from production renderer code.
import { PICTURE_MIME, type PictureType } from '../../../../src/document-review/formats'
import type { ReviewViewerPicture } from '../../document-review/types'
import { createReviewFixture } from '../document-review/fixtures'
import iconUrl from './fixtures/images/app-icon.png?url'
import screenshotUrl from './fixtures/images/company-create-error@2x.png?url'
import faviconUrl from './fixtures/images/favicon.ico?url'
import heicPngUrl from './fixtures/images/form-error-heic-as-png.png?url'
import avifUrl from './fixtures/images/form-error.avif?url'
import bmpUrl from './fixtures/images/form-error.bmp?url'
import gifUrl from './fixtures/images/form-error.gif?url'
import jpegUrl from './fixtures/images/form-error.jpg?url'
import webpUrl from './fixtures/images/form-error.webp?url'
import panoramaUrl from './fixtures/images/panorama-151mp.png?url'
import rotatedUrl from './fixtures/images/phone-photo-rotated.jpg?url'
import svgUrl from './fixtures/images/release-badge.svg?url'

interface PictureFile {
	name: string
	path: string
	type: PictureType
	url: string
	/** Bytes on disk when they differ from the served bytes (a converted HEIC). */
	fileSize?: number
	pixels?: { width: number; height: number }
}

const FILES = {
	screenshot: {
		name: 'company-create-error@2x.png',
		path: '~/Desktop/company-create-error@2x.png',
		type: 'png',
		url: screenshotUrl,
	},
	'screenshot-light': {
		name: 'company-create-error@2x.png',
		path: '~/Desktop/company-create-error@2x.png',
		type: 'png',
		url: screenshotUrl,
	},
	rotated: { name: 'IMG_2231.jpg', path: '~/Downloads/IMG_2231.jpg', type: 'jpeg', url: rotatedUrl },
	jpeg: { name: 'form-error.jpg', path: '~/Downloads/form-error.jpg', type: 'jpeg', url: jpegUrl },
	transparent: { name: 'app-icon.png', path: '~/code/helm/app/assets/app-icon.png', type: 'png', url: iconUrl },
	svg: { name: 'release-badge.svg', path: '~/code/helm/docs/release-badge.svg', type: 'svg', url: svgUrl },
	heic: {
		name: 'IMG_0412.HEIC',
		path: '~/Pictures/IMG_0412.HEIC',
		type: 'heic',
		url: heicPngUrl,
		fileSize: 7442,
		pixels: { width: 760, height: 520 },
	},
	gif: { name: 'form-error.gif', path: '~/Downloads/form-error.gif', type: 'gif', url: gifUrl },
	webp: { name: 'form-error.webp', path: '~/Downloads/form-error.webp', type: 'webp', url: webpUrl },
	avif: { name: 'form-error.avif', path: '~/Downloads/form-error.avif', type: 'avif', url: avifUrl },
	bmp: { name: 'form-error.bmp', path: '~/Downloads/form-error.bmp', type: 'bmp', url: bmpUrl },
	ico: { name: 'favicon.ico', path: '~/code/site/public/favicon.ico', type: 'ico', url: faviconUrl },
	'too-large': {
		name: 'panorama-151mp.png',
		path: '~/Pictures/panorama-151mp.png',
		type: 'png',
		url: panoramaUrl,
	},
} satisfies Record<string, PictureFile>

export type PictureFixtureScenario = keyof typeof FILES

/** The production review fixture in plain mode, showing one picture; `copied` keeps the PNGs the window sent. */
export function createPictureFixture(scenario: PictureFixtureScenario) {
	const file: PictureFile = FILES[scenario]
	const review = createReviewFixture('plain')
	const urls: string[] = []
	const copied: Uint8Array[] = []
	const api = {
		...review.api,
		copyImage: async (png: Uint8Array) => {
			copied.push(png)
			return { data: true as const }
		},
	}
	let revision = 1
	const theme = scenario.endsWith('-light') ? ('light' as const) : undefined
	// The window reads its theme once, when it opens; the bytes arrive later.
	if (theme) review.replaceDocument({}, theme)
	const show = (bytes: ArrayBuffer) => {
		const url = URL.createObjectURL(new Blob([bytes]))
		urls.push(url)
		const picture: ReviewViewerPicture = {
			url,
			type: file.type,
			mime: PICTURE_MIME[file.type],
			size: bytes.byteLength,
			fileSize: file.fileSize ?? bytes.byteLength,
			...(file.pixels ? { pixels: file.pixels } : {}),
		}
		review.replaceDocument({
			name: file.name,
			relativePath: file.path,
			format: 'image',
			text: '',
			previous: null,
			revision: String(revision++).padStart(64, '0'),
			picture,
		})
	}
	const load = (url: string) => fetch(url).then(response => response.arrayBuffer())
	const ready = load(file.url).then(show)
	return {
		...review,
		api,
		copied,
		ready,
		/** Stands in for a live reload: the file changed on disk and main issued a new token. */
		update: async (scenarioOrUrl: PictureFixtureScenario) => show(await load(FILES[scenarioOrUrl].url)),
		dispose: () => {
			review.dispose()
			for (const url of urls) URL.revokeObjectURL(url)
		},
	}
}
