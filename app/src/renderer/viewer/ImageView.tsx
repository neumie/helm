// The picture view of a plain `helm open` window (docs/plans/helm-open/spec.md, Formats: images; S3). The bytes
// come from the view's own helm-viewer: token; the header worker checks width × height and the 150 MP cap first,
// then Chromium decodes the bytes from a blob: URL with the type main declared (never sniffed). SVG is only ever an
// <img> source, never inline DOM, so its scripts, foreign objects and external references never run or load.
import {
	type KeyboardEvent as ReactKeyboardEvent,
	type PointerEvent as ReactPointerEvent,
	type Ref,
	useCallback,
	useEffect,
	useImperativeHandle,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from 'react'
import { PICTURE_WORDS, VIEWER_IMAGE_PIXELS, countText, sizeText } from '../../../../src/document-review/formats'
import { type ImageHeader, decodedAgrees, pixelLimitRefusal } from '../../../../src/document-review/image-header'
import type { ReviewViewerPicture } from '../../document-review/types'
import { checkImageHeader } from './image-client'
import { readTokenBytes } from './token-bytes'

/** Breathing room around a fitted image, on --well. */
const INSET = 24
export const MIN_SCALE = 0.05
export const MAX_SCALE = 16
const STEPS = [0.05, 0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16]
/** Arrow-key pan distance in CSS px (Shift multiplies). */
const PAN_STEP = 48

export type ZoomMode = { mode: 'fit' } | { mode: 'scale'; value: number }

export interface ImageStatus {
	position: string
	facts: string[]
	/** A newer version could not be shown; the last good picture stays on screen. */
	problem?: string
}
export interface ImageViewHandle {
	fit(): void
	actualSize(): void
	/** Encodes the shown picture as PNG at its pixel size and hands it to `onCopy`; resolves to a status word. */
	copy(): Promise<string>
}
export interface ImageViewProps {
	name: string
	picture: ReviewViewerPicture
	onStatus(status: ImageStatus): void
	/** ⌘= / ⌘- / ⌘0 from the window's shortcut dispatcher. */
	subscribeZoom?: (listener: (step: -1 | 0 | 1) => void) => () => void
	/** Puts PNG bytes on the clipboard (main checks the structure); resolves to an error message or null. */
	onCopy?: (png: Uint8Array) => Promise<string | null>
	handle?: Ref<ImageViewHandle>
}

interface Shown {
	src: string
	url: string
	header: ImageHeader | null
	width: number
	height: number
	transparent: boolean
}
interface Geometry {
	width: number
	height: number
	canvasWidth: number
	canvasHeight: number
	offsetX: number
	offsetY: number
}

const clampScale = (scale: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))

function fitScale(width: number, height: number, client: { width: number; height: number }): number {
	const sx = (client.width - INSET * 2) / width
	const sy = (client.height - INSET * 2) / height
	return clampScale(Math.min(sx, sy, 1))
}

function geometry(width: number, height: number, client: { width: number; height: number }, scale: number): Geometry {
	const w = width * scale
	const h = height * scale
	const canvasWidth = Math.max(client.width, Math.ceil(w + INSET * 2))
	const canvasHeight = Math.max(client.height, Math.ceil(h + INSET * 2))
	return {
		width: w,
		height: h,
		canvasWidth,
		canvasHeight,
		offsetX: (canvasWidth - w) / 2,
		offsetY: (canvasHeight - h) / 2,
	}
}

/** True when any pixel is not fully opaque. Samples a small copy of the same-origin blob (no taint). */
function hasTransparency(image: HTMLImageElement, width: number, height: number): boolean {
	const ratio = Math.min(1, 256 / Math.max(width, height))
	const w = Math.max(1, Math.round(width * ratio))
	const h = Math.max(1, Math.round(height * ratio))
	const canvas = document.createElement('canvas')
	canvas.width = w
	canvas.height = h
	const context = canvas.getContext('2d', { willReadFrequently: true })
	if (!context) return false
	try {
		context.drawImage(image, 0, 0, w, h)
		const data = context.getImageData(0, 0, w, h).data
		for (let i = 3; i < data.length; i += 4) if ((data[i] ?? 255) < 255) return true
	} catch {
		return false
	}
	return false
}

const percent = (scale: number) => `${Math.round(scale * 100)}%`
const ORIENTATION_WORDS: Readonly<Record<number, string>> = {
	2: 'Mirrored by EXIF',
	3: 'Rotated 180° by EXIF',
	4: 'Flipped by EXIF',
	5: 'Rotated and mirrored by EXIF',
	6: 'Rotated 90° by EXIF',
	7: 'Rotated and mirrored by EXIF',
	8: 'Rotated 270° by EXIF',
}

export function ImageView({ name, picture, onStatus, subscribeZoom, onCopy, handle }: ImageViewProps) {
	const rootRef = useRef<HTMLDivElement>(null)
	const imageRef = useRef<HTMLImageElement>(null)
	const [shown, setShown] = useState<Shown | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [reloadError, setReloadError] = useState<string | null>(null)
	const [loading, setLoading] = useState(true)
	const [client, setClient] = useState({ width: 0, height: 0 })
	const [zoomMode, setZoomMode] = useState<ZoomMode>({ mode: 'fit' })
	const [panning, setPanning] = useState(false)
	const pendingAnchor = useRef<{ ix: number; iy: number; cx: number; cy: number } | null>(null)
	const gesture = useRef<{ pointerId: number; x: number; y: number; left: number; top: number } | null>(null)
	const shownRef = useRef<Shown | null>(null)
	shownRef.current = shown

	// Each token (one readable version) is read, header-checked and decoded off screen; the previous picture stays
	// until the new one has decoded, so a live reload keeps zoom and pan and never flashes.
	const { url, size, type, mime } = picture
	useEffect(() => {
		const abort = new AbortController()
		const signal = abort.signal
		let made: string | null = null
		setLoading(true)
		// A reload that fails keeps the last good picture and its zoom and pan; only a first load shows the refusal.
		const failed = (message: string) => {
			if (shownRef.current) setReloadError(message)
			else {
				setError(message)
				setShown(null)
			}
		}
		void (async () => {
			try {
				let bytes = await readTokenBytes(url, size, signal)
				if (signal.aborted || bytes === null) return
				let header: ImageHeader | null = null
				if (type !== 'svg') {
					// A converted HEIC is the PNG `sips` made: its header is checked like any PNG.
					const checked = await checkImageHeader(name, type === 'heic' ? 'png' : type, bytes, signal)
					if (signal.aborted) return
					if (!checked.ok) {
						failed(checked.error)
						return
					}
					header = checked.header
					bytes = checked.bytes
				}
				made = URL.createObjectURL(new Blob([bytes], { type: mime }))
				const image = new Image()
				image.decoding = 'async'
				image.src = made
				try {
					await image.decode()
				} catch {
					if (signal.aborted) return
					failed(`${name} can't be shown: it could not be decoded as ${PICTURE_WORDS[type]}.`)
					return
				}
				if (signal.aborted) return
				// An SVG with no intrinsic size reports 0: the CSS default replaced-element box.
				const width = image.naturalWidth || 300
				const height = image.naturalHeight || 150
				if (header && !decodedAgrees(header, width, height)) {
					failed(
						`${name} can't be shown: its header says ${countText(header.width)} × ${countText(header.height)} but it decodes as ${countText(width)} × ${countText(height)}.`,
					)
					return
				}
				const refused = type === 'svg' ? pixelLimitRefusal(name, width, height) : null
				if (refused) {
					failed(refused)
					return
				}
				const next: Shown = {
					src: made,
					url,
					header,
					width,
					height,
					transparent: hasTransparency(image, width, height),
				}
				made = null
				setError(null)
				setReloadError(null)
				setShown(next)
			} catch (failure) {
				if (signal.aborted) return
				failed(failure instanceof Error ? failure.message : `${name} could not be read.`)
			} finally {
				if (!signal.aborted) setLoading(false)
			}
		})()
		return () => {
			abort.abort()
			if (made) URL.revokeObjectURL(made)
		}
	}, [url, size, type, mime, name])

	// The blob URL lives exactly as long as it is shown.
	useEffect(() => {
		const src = shown?.src
		return () => {
			if (src) URL.revokeObjectURL(src)
		}
	}, [shown?.src])

	useLayoutEffect(() => {
		const root = rootRef.current
		if (!root) return
		const measure = () => setClient({ width: root.clientWidth, height: root.clientHeight })
		measure()
		const observer = new ResizeObserver(measure)
		observer.observe(root)
		return () => observer.disconnect()
	}, [])

	const fit = shown && client.width > 0 ? fitScale(shown.width, shown.height, client) : 1
	const scale = zoomMode.mode === 'fit' ? fit : zoomMode.value
	const geo = useMemo(
		() => (shown && client.width > 0 ? geometry(shown.width, shown.height, client, scale) : null),
		[shown, client, scale],
	)
	const overflows = geo ? geo.canvasWidth > client.width || geo.canvasHeight > client.height : false

	// Keep the anchored image point under the cursor / view centre after a zoom.
	useLayoutEffect(() => {
		const root = rootRef.current
		const anchor = pendingAnchor.current
		if (!root || !geo || !anchor) return
		pendingAnchor.current = null
		root.scrollLeft = geo.offsetX + anchor.ix * scale - anchor.cx
		root.scrollTop = geo.offsetY + anchor.iy * scale - anchor.cy
	}, [geo, scale])

	useEffect(() => {
		if (!shown) {
			onStatus({ position: '', facts: [] })
			return
		}
		const facts = [
			picture.type === 'heic' ? 'HEIC, shown as PNG' : PICTURE_WORDS[picture.type],
			`${countText(shown.width)} × ${countText(shown.height)}`,
		]
		const orientation = shown.header?.orientation ?? 1
		if (orientation !== 1 && picture.type === 'jpeg') facts.push(ORIENTATION_WORDS[orientation] ?? 'Turned by EXIF')
		if (shown.header?.animated) facts.push('Animated')
		facts.push(sizeText(picture.fileSize))
		onStatus({
			position: zoomMode.mode === 'fit' ? `Fit · ${percent(scale)}` : percent(scale),
			facts,
			...(reloadError ? { problem: reloadError } : {}),
		})
	}, [shown, scale, zoomMode.mode, picture.type, picture.fileSize, reloadError, onStatus])

	const zoomTo = useCallback(
		(next: ZoomMode, around?: { cx: number; cy: number }) => {
			const root = rootRef.current
			if (!root || !geo) {
				setZoomMode(next)
				return
			}
			const cx = around?.cx ?? root.clientWidth / 2
			const cy = around?.cy ?? root.clientHeight / 2
			// A zoom that keeps the scale moves nothing; an anchor left armed would jump on a later resize or reload.
			const nextScale = next.mode === 'fit' ? fit : next.value
			if (Math.abs(nextScale - scale) < 1e-6) {
				pendingAnchor.current = null
				setZoomMode(next)
				return
			}
			pendingAnchor.current = {
				ix: (root.scrollLeft + cx - geo.offsetX) / scale,
				iy: (root.scrollTop + cy - geo.offsetY) / scale,
				cx,
				cy,
			}
			setZoomMode(next)
		},
		[geo, scale, fit],
	)

	const stepZoom = useCallback(
		(direction: 1 | -1) => {
			const next =
				direction > 0
					? (STEPS.find(step => step > scale + 0.001) ?? MAX_SCALE)
					: ([...STEPS].reverse().find(step => step < scale - 0.001) ?? MIN_SCALE)
			zoomTo({ mode: 'scale', value: next })
		},
		[scale, zoomTo],
	)

	const zoomStep = useRef<(step: -1 | 0 | 1) => void>(() => {})
	zoomStep.current = step => (step === 0 ? zoomTo({ mode: 'fit' }) : stepZoom(step))
	const actualSize = useRef(() => {})
	actualSize.current = () => zoomTo({ mode: 'scale', value: 1 })
	useEffect(() => subscribeZoom?.(step => zoomStep.current(step)), [subscribeZoom])

	// ⌘/Ctrl + wheel and trackpad pinch (Chromium reports pinch as ctrl+wheel) zoom at the cursor. Non-passive, so
	// the page itself never zooms.
	useEffect(() => {
		const root = rootRef.current
		if (!root) return
		const onWheel = (event: WheelEvent) => {
			if (!event.ctrlKey && !event.metaKey) return
			event.preventDefault()
			const rect = root.getBoundingClientRect()
			const factor = Math.exp(-event.deltaY * (event.deltaMode === 1 ? 0.05 : 0.0025))
			zoomTo(
				{ mode: 'scale', value: clampScale(scale * factor) },
				{ cx: event.clientX - rect.left, cy: event.clientY - rect.top },
			)
		}
		root.addEventListener('wheel', onWheel, { passive: false })
		return () => root.removeEventListener('wheel', onWheel)
	}, [scale, zoomTo])

	useImperativeHandle(
		handle,
		() => ({
			fit: () => zoomStep.current(0),
			actualSize: () => actualSize.current(),
			async copy() {
				const current = shownRef.current
				const image = imageRef.current
				if (!current || !image || !onCopy) return 'Nothing to copy'
				if (current.width * current.height > VIEWER_IMAGE_PIXELS) return 'This image is too large to copy'
				const canvas = document.createElement('canvas')
				canvas.width = current.width
				canvas.height = current.height
				const context = canvas.getContext('2d')
				if (!context) return 'This image is too large to copy'
				// drawImage applies the orientation the <img> shows, so the copy matches the screen.
				context.drawImage(image, 0, 0, current.width, current.height)
				const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'))
				canvas.width = 0
				canvas.height = 0
				if (!blob) return 'This image is too large to copy'
				const failed = await onCopy(new Uint8Array(await blob.arrayBuffer()))
				return failed ?? 'Copied as PNG'
			},
		}),
		[onCopy],
	)

	const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
		const root = rootRef.current
		if (event.button !== 0 || !root || !overflows) return
		gesture.current = {
			pointerId: event.pointerId,
			x: event.clientX,
			y: event.clientY,
			left: root.scrollLeft,
			top: root.scrollTop,
		}
		setPanning(true)
		event.currentTarget.setPointerCapture(event.pointerId)
	}
	const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
		const current = gesture.current
		const root = rootRef.current
		if (!current || current.pointerId !== event.pointerId || !root) return
		root.scrollLeft = current.left - (event.clientX - current.x)
		root.scrollTop = current.top - (event.clientY - current.y)
	}
	const endPan = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (gesture.current?.pointerId !== event.pointerId) return
		gesture.current = null
		setPanning(false)
	}

	const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
		if (event.metaKey || event.ctrlKey || event.altKey) return
		const root = rootRef.current
		if (!root) return
		const pan = PAN_STEP * (event.shiftKey ? 4 : 1)
		switch (event.key) {
			case '0':
				zoomTo({ mode: 'fit' })
				break
			case '1':
				zoomTo({ mode: 'scale', value: 1 })
				break
			case '+':
			case '=':
				stepZoom(1)
				break
			case '-':
			case '_':
				stepZoom(-1)
				break
			case 'ArrowLeft':
				root.scrollBy({ left: -pan })
				break
			case 'ArrowRight':
				root.scrollBy({ left: pan })
				break
			case 'ArrowUp':
				root.scrollBy({ top: -pan })
				break
			case 'ArrowDown':
				root.scrollBy({ top: pan })
				break
			default:
				return
		}
		event.preventDefault()
	}

	const cursor = panning ? 'grabbing' : overflows ? 'grab' : 'default'
	const label = shown
		? `${name}, ${shown.width} by ${shown.height} pixels, ${zoomMode.mode === 'fit' ? 'fitted at ' : ''}${percent(scale)}`
		: name

	return (
		<div
			ref={rootRef}
			className="viewer-picture"
			data-cursor={cursor}
			data-picture-type={picture.type}
			// biome-ignore lint/a11y/noNoninteractiveTabindex: the view is a keyboard-operated pan/zoom surface
			tabIndex={0}
			role="img"
			aria-label={label}
			aria-keyshortcuts="0 1 + - ArrowLeft ArrowRight ArrowUp ArrowDown"
			onKeyDown={onKeyDown}
		>
			{error ? (
				<p className="viewer-note" role="alert">
					{error}
				</p>
			) : null}
			{!error && !shown && loading ? <p className="viewer-note">Reading {name}…</p> : null}
			{shown && !error ? (
				<div
					className="viewer-picture-canvas"
					style={
						geo
							? { width: geo.canvasWidth, height: geo.canvasHeight }
							: { position: 'absolute', width: 1, height: 1, opacity: 0, overflow: 'hidden' }
					}
					onPointerDown={onPointerDown}
					onPointerMove={onPointerMove}
					onPointerUp={endPan}
					onPointerCancel={endPan}
				>
					<img
						ref={imageRef}
						className="viewer-picture-image"
						data-transparent={shown.transparent ? '' : undefined}
						data-pixelated={scale > 2 ? '' : undefined}
						src={shown.src}
						alt=""
						draggable={false}
						style={geo ? { left: geo.offsetX, top: geo.offsetY, width: geo.width, height: geo.height } : undefined}
					/>
				</div>
			) : null}
		</div>
	)
}
