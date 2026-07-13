// Settings — push pages over the pane (§3.10): a grouped section list, then
// one pushed page per section rendering the server-owned edit metadata from
// GET /api/config/full (field semantics mirror the old web SettingsPage; the
// daemon owns which fields exist and how secrets redact). Draft state lives in
// a store owned by SidebarRoot so edits survive section navigation.

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type {
	ConfigDocument,
	ConfigEditField,
	ConfigEditFieldControl,
	ConfigEditListControl,
	ConfigEditSection,
} from '../../shared-helm'
import { appearance } from '../appearance'
import { showToast } from '../toast'
import {
	ActionRow,
	Btn,
	Card,
	EmptyState,
	FieldLabel,
	PushHeader,
	SelectInput,
	TextArea,
	TextInput,
	Toggle,
} from './ui'

type Draft = Record<string, unknown>

export interface SettingsStore {
	doc: ConfigDocument | null
	draft: Draft | null
	dirty: boolean
	saving: boolean
	loadError: string | null
	/** Saved but not applied (runs active / no launchd): the daemon's message. */
	pendingRestart: string | null
	restarting: boolean
	update: (path: string[], value: unknown) => void
	addListItem: (control: ConfigEditListControl) => void
	removeListItem: (control: ConfigEditListControl, index: number) => void
	save: () => Promise<void>
	/** "Restart now" on the pending-restart notice → POST /api/daemon/restart. */
	restartNow: () => Promise<void>
}

/** Owned by SidebarRoot while any settings route is on the stack. */
export function useSettingsStore(active: boolean): SettingsStore {
	const [doc, setDoc] = useState<ConfigDocument | null>(null)
	const [draft, setDraft] = useState<Draft | null>(null)
	const [dirty, setDirty] = useState(false)
	const [saving, setSaving] = useState(false)
	const [loadError, setLoadError] = useState<string | null>(null)
	const [pendingRestart, setPendingRestart] = useState<string | null>(null)
	const [restarting, setRestarting] = useState(false)

	useEffect(() => {
		if (!active) {
			// Fully popped: drop the draft so the next open loads fresh config.
			setDoc(null)
			setDraft(null)
			setDirty(false)
			setLoadError(null)
			setPendingRestart(null)
			return
		}
		let alive = true
		void window.helm.daemon.config().then(result => {
			if (!alive) return
			if (result.error !== undefined) setLoadError(result.error)
			else {
				setDoc(result.data)
				setDraft(result.data.config as Draft)
			}
		})
		return () => {
			alive = false
		}
	}, [active])

	const update = useCallback((path: string[], value: unknown) => {
		setDirty(true)
		setDraft(prev => {
			if (!prev) return prev
			const next = structuredClone(prev)
			setAtPath(next, path, value)
			return next
		})
	}, [])

	const addListItem = useCallback((control: ConfigEditListControl) => {
		setDirty(true)
		setDraft(prev => {
			if (!prev) return prev
			const next = structuredClone(prev)
			const list = getAtPath(next, control.path)
			if (Array.isArray(list)) list.push(structuredClone(control.defaultItem))
			else setAtPath(next, control.path, [structuredClone(control.defaultItem)])
			return next
		})
	}, [])

	const removeListItem = useCallback((control: ConfigEditListControl, index: number) => {
		setDirty(true)
		setDraft(prev => {
			if (!prev) return prev
			const next = structuredClone(prev)
			const list = getAtPath(next, control.path)
			if (Array.isArray(list)) list.splice(index, 1)
			return next
		})
	}, [])

	const save = useCallback(async () => {
		if (!draft) return
		setSaving(true)
		try {
			const result = await window.helm.daemon.updateConfig(draft)
			if (result.error !== undefined) showToast({ message: 'Save failed', detail: result.error, ttlMs: 6000 })
			else {
				setDirty(false)
				if (result.data.applied) {
					// The daemon restarts itself to load the change (~2s blip the
					// bridge rides out on last-known data) — the save IS applied.
					setPendingRestart(null)
					showToast({ message: 'Settings applied' })
				} else {
					// Saved to disk but the daemon still runs the old config —
					// keep a persistent notice with the way out (§3.12).
					setPendingRestart(result.data.message)
				}
			}
		} finally {
			setSaving(false)
		}
	}, [draft])

	const restartNow = useCallback(async () => {
		setRestarting(true)
		try {
			const result = await window.helm.daemon.restartDaemon()
			if (result.error !== undefined) {
				showToast({ message: 'Restart failed', detail: result.error, ttlMs: 6000 })
			} else {
				setPendingRestart(null)
				showToast({ message: 'Daemon restarting', detail: 'Settings apply in a few seconds.' })
			}
		} finally {
			setRestarting(false)
		}
	}, [])

	return {
		doc,
		draft,
		dirty,
		saving,
		loadError,
		pendingRestart,
		restarting,
		update,
		addListItem,
		removeListItem,
		save,
		restartNow,
	}
}

function SaveBar({ store }: { store: SettingsStore }) {
	if (!store.dirty && !store.pendingRestart) return null
	return (
		<div className="action-bar action-bar-stack">
			{store.pendingRestart && (
				<output className="restart-notice">
					<span className="restart-notice-text">{store.pendingRestart}</span>
					<Btn sm busy={store.restarting} onClick={() => void store.restartNow()}>
						{store.restarting ? 'Restarting' : 'Restart now'}
					</Btn>
				</output>
			)}
			{store.dirty && (
				<Btn tone="primary" block busy={store.saving} onClick={() => void store.save()}>
					{store.saving ? 'Saving' : 'Save changes'}
				</Btn>
			)}
		</div>
	)
}

/** Grouped section cards (§3.15): the card head row is the grouping, so
 *  section rows drop their "AI · " namespace prefix. Sections the daemon adds
 *  later land in a trailing "Other" card instead of disappearing. */
const SECTION_GROUPS: ReadonlyArray<{ label: string; ids: string[] }> = [
	{ label: 'Daemon', ids: ['provider', 'projects', 'polling', 'server'] },
	{ label: 'Execution', ids: ['solver', 'execution', 'spawner'] },
	{ label: 'AI', ids: ['ai-branch', 'ai-display', 'ai-model-guidance', 'ai-triage'] },
	{ label: 'Integrations', ids: ['github'] },
]

function groupedSections(sections: ConfigEditSection[]): Array<{ label: string; sections: ConfigEditSection[] }> {
	const byId = new Map(sections.map(section => [section.id, section]))
	const groups = SECTION_GROUPS.map(group => ({
		label: group.label,
		sections: group.ids.flatMap(id => byId.get(id) ?? []),
	})).filter(group => group.sections.length > 0)
	const known = new Set(SECTION_GROUPS.flatMap(group => group.ids))
	const other = sections.filter(section => !known.has(section.id))
	if (other.length > 0) groups.push({ label: 'Other', sections: other })
	return groups
}

/** Row title without the "AI · " grouping hack — the card head carries that. */
function sectionRowTitle(section: ConfigEditSection): string {
	return section.title.replace(/^AI\s*·\s*/, '')
}

/** Root settings page: the app-local Helm card (Appearance — no daemon
 *  involved, so it renders even when config is unavailable), then grouped
 *  daemon section cards; each row pushes its own page. */
export function SettingsPage({
	store,
	onBack,
	onOpenSection,
	onOpenAppearance,
}: {
	store: SettingsStore
	onBack: () => void
	onOpenSection: (sectionId: string) => void
	onOpenAppearance: () => void
}) {
	const sections = store.doc?.edit.sections ?? []
	const look = useSyncExternalStore(appearance.subscribe, appearance.getSnapshot)
	const themeName = look.themes.find(theme => theme.id === look.state.themeId)?.name ?? look.state.themeId
	return (
		<div className="page-frame">
			<PushHeader title="Settings" onBack={onBack} />
			<div className="page-scroll">
				<Card label="Helm" flush>
					<ActionRow
						nav
						label="Appearance"
						value={`${themeName} · ${look.state.termFontSize}px`}
						onClick={onOpenAppearance}
					/>
				</Card>
				{store.loadError ? (
					<EmptyState title="Config unavailable" detail={store.loadError} />
				) : sections.length === 0 ? (
					<EmptyState title="Loading settings" detail="Fetching config from the daemon." />
				) : (
					groupedSections(sections).map(group => (
						<Card key={group.label} label={group.label} flush>
							{group.sections.map(section => (
								<ActionRow
									key={section.id}
									nav
									label={sectionRowTitle(section)}
									value={sectionSummary(section, store.draft, sections)}
									onClick={() => onOpenSection(section.id)}
								/>
							))}
						</Card>
					))
				)}
			</div>
			<SaveBar store={store} />
		</div>
	)
}

/** Current-state summary for a section row. Every row gets one — a blank cell
 *  next to a chevron reads as broken (§3.15) — with units and real state:
 *  "60s", "2 of 3 on", "default", never a unit-less number or a fake boolean. */
function sectionSummary(section: ConfigEditSection, draft: Draft | null, sections: ConfigEditSection[]): string {
	if (!draft) return ''
	switch (section.id) {
		case 'projects': {
			const list = getAtPath(draft, ['projects'])
			const count = Array.isArray(list) ? list.length : 0
			return count === 1 ? '1 project' : `${count} projects`
		}
		case 'polling': {
			const seconds = getAtPath(draft, ['polling', 'intervalSeconds'])
			if (typeof seconds === 'number' && Number.isFinite(seconds)) return `${seconds}s`
			break
		}
		case 'solver': {
			const agent = selectValueLabel(section, ['solver', 'agent'], draft)
			if (agent !== '') return agent
			break
		}
		case 'execution': {
			// Short state, not the verbose select label ("Worktree (isolated, default)").
			const workspace = getAtPath(draft, ['solver', 'workspace'])
			if (workspace === 'main') return 'Main'
			if (workspace === 'worktree') return 'Worktree'
			break
		}
		case 'server': {
			// Where the daemon answers, not a bare port number.
			const port = getAtPath(draft, ['server', 'port'])
			if (typeof port === 'number' && Number.isFinite(port)) {
				const host = getAtPath(draft, ['server', 'host'])
				const shown = typeof host === 'string' && host !== '' && host !== '0.0.0.0' ? host : 'localhost'
				return `${shown}:${port}`
			}
			break
		}
		case 'spawner':
			return spawnerSummary(draft, sections)
		case 'ai-model-guidance':
			return guidanceSummary(section, draft)
		case 'github':
			return toggleSummary(section, draft)
	}
	return firstCompactValue(section, draft)
}

/** Humanized spawner adapter name — raw ids stay inside the editor page:
 *  "okena" → "Okena"; "default" → the solver-agent label ("Claude Code"). */
function spawnerSummary(draft: Draft, sections: ConfigEditSection[]): string {
	const name = getAtPath(draft, ['spawner', 'name'])
	if (typeof name !== 'string' || name === '') return '—'
	if (name === 'default') {
		const solver = sections.find(s => s.id === 'solver')
		const agent = solver ? selectValueLabel(solver, ['solver', 'agent'], draft) : ''
		return agent !== '' ? agent : 'Solver agent'
	}
	return name.charAt(0).toUpperCase() + name.slice(1)
}

function fieldsOf(section: ConfigEditSection): ConfigEditFieldControl[] {
	return section.controls.filter((control): control is ConfigEditFieldControl => control.type === 'field')
}

/** The option label for a select field's current value ("Claude Code", not "claude"). */
function selectValueLabel(section: ConfigEditSection, path: string[], draft: Draft): string {
	const key = path.join('.')
	const field = fieldsOf(section).find(f => f.input === 'select' && f.path.join('.') === key)
	const value = getAtPath(draft, path)
	if (!field || typeof value !== 'string' || value === '') return ''
	return field.options?.find(option => option.value === value)?.label ?? value
}

/** "N of M on" across a section's toggles — independent booleans never
 *  collapse into one fake on/off. */
function toggleSummary(section: ConfigEditSection, draft: Draft): string {
	const toggles = fieldsOf(section).filter(f => f.input === 'boolean')
	if (toggles.length === 0) return firstCompactValue(section, draft)
	const on = toggles.filter(f => getAtPath(draft, f.path) === true).length
	return `${on} of ${toggles.length} on`
}

/** Model guidance: hydrated values equal their built-in placeholder until the
 *  user edits them, so "custom" = differs from the placeholder. */
function guidanceSummary(section: ConfigEditSection, draft: Draft): string {
	const custom = fieldsOf(section).filter(f => {
		const value = getAtPath(draft, f.path)
		return typeof value === 'string' && value.trim() !== '' && value !== (f.placeholder ?? '')
	}).length
	return custom === 0 ? 'default' : `${custom} custom`
}

/** Fallback: the first compact field (select label / on–off / number). */
function firstCompactValue(section: ConfigEditSection, draft: Draft): string {
	for (const field of fieldsOf(section)) {
		if (field.secret) continue
		if (field.input !== 'select' && field.input !== 'boolean' && field.input !== 'number') continue
		const value = getAtPath(draft, field.path)
		if (value === undefined || value === null || value === '') continue
		if (typeof value === 'boolean') return value ? 'on' : 'off'
		if (field.input === 'select' && typeof value === 'string') {
			return field.options?.find(option => option.value === value)?.label ?? value
		}
		const text = String(value)
		return text.length > 24 ? `${text.slice(0, 24)}…` : text
	}
	return '—'
}

export function SettingsSectionPage({
	store,
	sectionId,
	onBack,
}: {
	store: SettingsStore
	sectionId: string
	onBack: () => void
}) {
	const section = useMemo(() => store.doc?.edit.sections.find(s => s.id === sectionId) ?? null, [store.doc, sectionId])
	if (!section || !store.draft) {
		return (
			<div className="page-frame">
				<PushHeader title="Settings" onBack={onBack} />
				<EmptyState title="Section unavailable" detail="Go back and reopen settings." />
			</div>
		)
	}
	const draft = store.draft
	const lists = section.controls.filter(control => control.type === 'list')
	return (
		<div className="page-frame">
			<PushHeader
				title={section.title}
				onBack={onBack}
				trailing={
					lists.length === 1 && lists[0] ? (
						<Btn sm onClick={() => store.addListItem(lists[0] as ConfigEditListControl)}>
							{(lists[0] as ConfigEditListControl).addLabel}
						</Btn>
					) : undefined
				}
			/>
			<div className="page-scroll">
				{section.description && <p className="section-description">{section.description}</p>}
				{section.controls.map(control =>
					control.type === 'list' ? (
						<ListControl key={control.path.join('.')} control={control} store={store} />
					) : (
						<div key={control.path.join('.')} className="settings-field">
							<FieldControl
								field={control}
								value={getAtPath(draft, control.path)}
								onChange={v => store.update(control.path, v)}
							/>
						</div>
					),
				)}
			</div>
			<SaveBar store={store} />
		</div>
	)
}

function ListControl({ control, store }: { control: ConfigEditListControl; store: SettingsStore }) {
	const raw = store.draft ? getAtPath(store.draft, control.path) : undefined
	const items = Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : []
	if (items.length === 0) {
		return <p className="section-description">{control.emptyLabel}</p>
	}
	return (
		<>
			{items.map((item, index) => (
				<Card
					// biome-ignore lint/suspicious/noArrayIndexKey: rows are edited/removed by index against the saved config
					key={index}
					label={String(getAtPath(item, control.itemTitlePath) || `Item ${index + 1}`)}
					trailing={
						<Btn sm tone="danger" onClick={() => store.removeListItem(control, index)}>
							Remove
						</Btn>
					}
				>
					{control.fields.map(field => (
						<div key={field.path.join('.')} className="settings-field">
							<FieldControl
								field={field}
								value={getAtPath(item, field.path)}
								onChange={v => store.update([...control.path, String(index), ...field.path], v)}
							/>
						</div>
					))}
				</Card>
			))}
		</>
	)
}

function FieldControl({
	field,
	value,
	onChange,
}: {
	field: ConfigEditField
	value: unknown
	onChange: (value: unknown) => void
}) {
	const id = `cfg-${field.path.join('-')}`
	if (field.input === 'boolean') {
		return (
			<div className="toggle-row">
				<span className="toggle-label">{field.label}</span>
				<Toggle label={field.label} value={Boolean(value)} onChange={onChange} />
			</div>
		)
	}
	if (field.input === 'select') {
		return (
			<>
				<FieldLabel htmlFor={id}>{field.label}</FieldLabel>
				<SelectInput
					id={id}
					value={String(value ?? '')}
					onChange={next => onChange(normalizeText(next, field))}
					options={field.options ?? []}
				/>
			</>
		)
	}
	if (field.input === 'textarea') {
		return (
			<>
				<FieldLabel htmlFor={id}>{field.label}</FieldLabel>
				<TextArea
					id={id}
					value={String(value ?? '')}
					placeholder={field.placeholder}
					onChange={next => onChange(normalizeText(next, field))}
					rows={7}
				/>
			</>
		)
	}
	if (field.input === 'color') {
		return (
			<>
				<FieldLabel htmlFor={id}>{field.label}</FieldLabel>
				<div className="color-field">
					<input
						id={id}
						type="color"
						className="color-input"
						value={typeof value === 'string' && value ? value : '#808080'}
						onChange={event => onChange(normalizeText(event.target.value, field))}
					/>
					{typeof value === 'string' && value !== '' && (
						<Btn tone="ghost" sm onClick={() => onChange(undefined)}>
							Clear
						</Btn>
					)}
				</div>
			</>
		)
	}
	const type = field.input === 'password' ? 'password' : field.input === 'number' ? 'number' : 'text'
	const invalid = Boolean(field.required) && String(value ?? '').trim() === ''
	return (
		<>
			<FieldLabel htmlFor={id}>{field.label}</FieldLabel>
			<TextInput
				id={id}
				type={type}
				value={String(value ?? '')}
				placeholder={field.placeholder}
				invalid={invalid}
				onChange={next => onChange(normalizeField(next, field))}
			/>
		</>
	)
}

function normalizeField(value: string, field: ConfigEditField): unknown {
	if (field.input === 'number') return value.trim() === '' && !field.required ? undefined : Number(value)
	return normalizeText(value, field)
}

function normalizeText(value: string, field: ConfigEditField): unknown {
	return value === '' && !field.required ? undefined : value
}

function getAtPath(source: unknown, path: string[]): unknown {
	let current = source
	for (const segment of path) {
		if (typeof current !== 'object' || current === null) return undefined
		current = (current as Record<string, unknown>)[segment]
	}
	return current
}

function setAtPath(target: Record<string, unknown>, path: string[], value: unknown): void {
	let current: Record<string, unknown> = target
	for (let i = 0; i < path.length - 1; i++) {
		const segment = path[i] as string
		const nextSegment = path[i + 1] as string
		const existing = current[segment]
		if (typeof existing !== 'object' || existing === null) {
			current[segment] = /^\d+$/.test(nextSegment) ? [] : {}
		}
		current = current[segment] as Record<string, unknown>
	}
	const last = path[path.length - 1] as string
	if (value === undefined) delete current[last]
	else current[last] = value
}
