// Every production icon from the icon module (./icons.ts), in both forms, with its source: one set, Heroicons
// v2.2.0 24px outline at stroke 2 (docs/design-system.md §3.1 Icons, §9 ruling 95).
import type { Meta, StoryObj } from '@storybook/react-vite'
import { useEffect, useRef } from 'react'
import { Icon } from './Icon'
import { ICONS, ICONS_OUTSIDE_MODULE, type IconData, type IconName, type IconSource, iconNode } from './icons'

const meta: Meta = {
	title: 'Primitives/Icons',
	parameters: { layout: 'fullscreen' },
}

export default meta
type Story = StoryObj

const CSS = `
.icons-gallery { padding: 16px 24px; background: var(--pane); color: var(--text-1); font-family: var(--font-ui); font-size: 12px; }
.icons-gallery h2 { margin: 16px 0 8px; color: var(--text-0); font-size: 13px; font-weight: 600; }
.icons-gallery table { border-collapse: collapse; }
.icons-gallery th { padding: 4px 12px; color: var(--text-2); font-weight: 500; text-align: left; }
.icons-gallery td { padding: 6px 12px; vertical-align: middle; }
.icons-gallery .icons-glyph { display: inline-flex; width: 24px; height: 24px; align-items: center; justify-content: center; color: var(--text-0); }
.icons-gallery .icons-name { color: var(--text-0); font-family: var(--font-mono); }
`

function sourceText(source: IconSource): string {
	return `Heroicons ${source.name}, ${source.style}, ${source.revision} (${source.license})`
}

function SourceCell({ source }: { source: IconSource | readonly IconSource[] }) {
	const sources: readonly IconSource[] = Array.isArray(source) ? source : [source as IconSource]
	return <td>{sources.map(sourceText).join('; ')}</td>
}

/** The DOM form, mounted as the terminal workspace mounts it. */
function DomIcon({ icon }: { icon: IconData }) {
	const host = useRef<HTMLSpanElement>(null)
	useEffect(() => {
		host.current?.replaceChildren(iconNode(icon))
	}, [icon])
	return <span ref={host} className="icons-glyph" />
}

function IconGallery() {
	const names = Object.keys(ICONS) as IconName[]
	return (
		<div className="icons-gallery">
			<style>{CSS}</style>
			<h2>{names.length} icons in app/src/renderer/icons/icons.ts · Heroicons 24 outline, stroke 2</h2>
			<table>
				<thead>
					<tr>
						<th>React</th>
						<th>DOM</th>
						<th>Name</th>
						<th>Source</th>
						<th>Used by</th>
					</tr>
				</thead>
				<tbody>
					{names.map(name => (
						<tr key={name} data-icon={name}>
							<td>
								<span className="icons-glyph">
									<Icon icon={ICONS[name]} />
								</span>
							</td>
							<td>
								<DomIcon icon={ICONS[name]} />
							</td>
							<td className="icons-name">{name}</td>
							<SourceCell source={ICONS[name].source} />
							<td>{ICONS[name].usedBy}</td>
						</tr>
					))}
				</tbody>
			</table>
			<h2>Outside the module</h2>
			<table>
				<thead>
					<tr>
						<th>File</th>
						<th>What</th>
						<th>Source</th>
						<th>Why</th>
					</tr>
				</thead>
				<tbody>
					{ICONS_OUTSIDE_MODULE.map(entry => (
						<tr key={entry.file}>
							<td className="icons-name">{entry.file}</td>
							<td>{entry.what}</td>
							<SourceCell source={entry.source} />
							<td>{entry.reason}</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	)
}

export const Gallery: Story = { render: () => <IconGallery /> }
