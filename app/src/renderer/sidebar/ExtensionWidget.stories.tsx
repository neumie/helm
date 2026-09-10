import type { Meta, StoryObj } from '@storybook/react-vite'
import { useEffect, useRef, useState } from 'react'

function ExtensionWorkbench() {
	const ref = useRef<HTMLDivElement>(null)
	const [error, setError] = useState<string | null>(null)
	useEffect(() => {
		let disposed = false
		let unmount: (() => void) | undefined
		// Build with `cd extension && node build-workbench.mjs`; this is compiled Solid, not React JSX.
		const url = new URL('../../../../extension/dist/workbench.js', import.meta.url).href
		void import(/* @vite-ignore */ url)
			.then(module => {
				if (!disposed && ref.current) unmount = module.mountWidgetWorkbench(ref.current)
			})
			.catch(reason => setError(String(reason)))
		return () => {
			disposed = true
			unmount?.()
		}
	}, [])
	return <div ref={ref}>{error ? <p role="alert">Build the extension workbench bundle: {error}</p> : null}</div>
}

const meta: Meta = { title: 'Views/Extension widget', parameters: { layout: 'fullscreen' } }
export default meta
type Story = StoryObj
export const ClosedShadow: Story = { render: () => <ExtensionWorkbench /> }
