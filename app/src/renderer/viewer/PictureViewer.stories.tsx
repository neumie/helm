import type { Meta, StoryObj } from '@storybook/react-vite'
import { useEffect, useMemo } from 'react'
import '../document-review/document-review.css'
import '../styles.css'
import '../sidebar/sidebar.css'
import { DocumentReview } from '../document-review/DocumentReview'
import { type PictureFixtureScenario, createPictureFixture } from './picture-fixtures'

declare global {
	interface Window {
		__helmPictureProof?: ReturnType<typeof createPictureFixture>
	}
}

function PictureFixture({ scenario }: { scenario: PictureFixtureScenario }) {
	const fixture = useMemo(() => createPictureFixture(scenario), [scenario])
	useEffect(() => {
		window.__helmPictureProof = fixture
		return () => {
			if (window.__helmPictureProof === fixture) window.__helmPictureProof = undefined
			fixture.dispose()
		}
	}, [fixture])
	return <DocumentReview api={fixture.api} />
}

const meta: Meta<typeof PictureFixture> = {
	title: 'Views/Document review/Pictures',
	component: PictureFixture,
	parameters: { layout: 'fullscreen' },
}
export default meta
type Story = StoryObj<typeof PictureFixture>

const describe = (story: string) => ({ docs: { description: { story } } })

export const Screenshot: Story = {
	args: { scenario: 'screenshot' },
	parameters: describe(
		'`helm open company-create-error@2x.png`: fitted to the window with a 24px inset. Keys: 0 fit, 1 actual size, + / − zoom, arrows pan (Shift: further); ⌘= / ⌘− / ⌘0 and pinch zoom too; drag pans when the picture is larger than the view. ⌘C copies it as PNG. The status line shows the zoom, format, pixel size and file size.',
	),
}
export const ScreenshotLightWindow: Story = {
	args: { scenario: 'screenshot-light' },
	parameters: describe('The light window: the chrome changes, the picture keeps its own colors on the well.'),
}
export const ExifRotated: Story = {
	args: { scenario: 'rotated' },
	parameters: describe(
		'A phone photo stored 760 × 520 with EXIF orientation 6: shown upright at 520 × 760, and the status line says it was rotated by EXIF.',
	),
}
export const Transparent: Story = {
	args: { scenario: 'transparent' },
	parameters: describe('A checkerboard appears only under pictures that actually have transparent pixels.'),
}
export const Svg: Story = {
	args: { scenario: 'svg' },
	parameters: describe(
		'An SVG is shown as an image, never inline: its <script>, <foreignObject> and external <image href="https://…"> do nothing and load nothing.',
	),
}
export const Heic: Story = {
	args: { scenario: 'heic' },
	parameters: describe(
		'A HEIC photo: main converts it with macOS `sips` in a child process and the window shows that PNG. The status line says so.',
	),
}
export const TooLarge: Story = {
	args: { scenario: 'too-large' },
	parameters: describe(
		'A header claiming 15,100 × 10,000 pixels: refused with the numbers before anything decodes (the cap is 150 MP).',
	),
}
export const Gif: Story = { args: { scenario: 'gif' } }
export const WebP: Story = { args: { scenario: 'webp' } }
export const Avif: Story = { args: { scenario: 'avif' } }
export const Bmp: Story = { args: { scenario: 'bmp' } }
export const Ico: Story = {
	args: { scenario: 'ico' },
	parameters: describe(
		'A 48 px favicon: fit never enlarges past 100%, so small pictures stay crisp at their own size.',
	),
}
