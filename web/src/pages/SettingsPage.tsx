import { type ReactNode, useCallback, useEffect, useState } from 'react'
import { type ConfigDocument, type ConfigEditField, type ConfigEditListControl, api } from '../api'

type Config = Record<string, unknown>

export function SettingsPage() {
	const [document, setDocument] = useState<ConfigDocument | null>(null)
	const [config, setConfig] = useState<Config | null>(null)
	const [saving, setSaving] = useState(false)
	const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
	const [dirty, setDirty] = useState(false)
	const [activeSection, setActiveSection] = useState<string | null>(null)

	useEffect(() => {
		api
			.configFull()
			.then(doc => {
				setDocument(doc)
				setConfig(doc.config)
			})
			.catch(err => {
				setMessage({ type: 'error', text: `Failed to load config: ${err.message}` })
			})
	}, [])

	const handleSave = useCallback(async () => {
		if (!config) return
		setSaving(true)
		setMessage(null)
		try {
			const result = await api.updateConfig(config)
			setMessage({ type: 'success', text: result.message })
			setDirty(false)
		} catch (err) {
			setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Save failed' })
		} finally {
			setSaving(false)
		}
	}, [config])

	const update = useCallback((path: string[], value: unknown) => {
		setDirty(true)
		setConfig(prev => {
			if (!prev) return prev
			const next = structuredClone(prev)
			setAtPath(next, path, value)
			return next
		})
	}, [])

	const addListItem = useCallback((control: ConfigEditListControl) => {
		setDirty(true)
		setConfig(prev => {
			if (!prev) return prev
			const next = structuredClone(prev)
			const list = getAtPath(next, control.path)
			if (Array.isArray(list)) {
				list.push(structuredClone(control.defaultItem))
			} else {
				setAtPath(next, control.path, [structuredClone(control.defaultItem)])
			}
			return next
		})
	}, [])

	const removeListItem = useCallback((control: ConfigEditListControl, index: number) => {
		setDirty(true)
		setConfig(prev => {
			if (!prev) return prev
			const next = structuredClone(prev)
			const list = getAtPath(next, control.path)
			if (Array.isArray(list)) list.splice(index, 1)
			return next
		})
	}, [])

	const sections = document?.edit.sections ?? []
	// Only the selected section renders; unsaved edits in other sections live in
	// the shared `config` state, so switching sections never loses them.
	const currentSection = sections.find(section => section.id === activeSection) ?? sections[0] ?? null

	if (!config || !document) {
		return <div style={{ padding: 40, color: 'var(--text-3)' }}>{message ? message.text : 'Loading config...'}</div>
	}

	return (
		<div style={{ maxWidth: 900, margin: '0 auto', padding: '32px 24px' }}>
			<div
				style={{
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'space-between',
					marginBottom: 28,
					paddingBottom: 16,
					borderBottom: '1px solid var(--border)',
				}}
			>
				<div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
					<a
						href="/"
						style={{
							color: 'var(--text-3)',
							textDecoration: 'none',
							fontSize: 13,
							display: 'flex',
							alignItems: 'center',
							gap: 4,
						}}
					>
						&larr; Dashboard
					</a>
					<h1 style={{ fontSize: 20, fontWeight: 600, color: 'var(--text-0)' }}>Settings</h1>
				</div>
				<button
					type="button"
					onClick={handleSave}
					disabled={saving || !dirty}
					style={{
						padding: '7px 24px',
						background: dirty ? 'var(--accent)' : 'var(--bg-3)',
						border: 'none',
						borderRadius: 'var(--radius-sm)',
						color: dirty ? '#fff' : 'var(--text-4)',
						cursor: saving || !dirty ? 'default' : 'pointer',
						fontSize: 13,
						fontFamily: 'var(--font-sans)',
						fontWeight: 500,
						opacity: saving ? 0.6 : 1,
						transition: 'all 150ms',
					}}
				>
					{saving ? 'Saving...' : dirty ? 'Save changes' : 'Saved'}
				</button>
			</div>

			{message && (
				<div
					style={{
						padding: '10px 14px',
						marginBottom: 20,
						borderRadius: 'var(--radius-sm)',
						background: message.type === 'success' ? 'var(--green-dim)' : 'var(--red-dim)',
						color: message.type === 'success' ? 'var(--green)' : 'var(--red)',
						fontSize: 13,
						border: `1px solid ${message.type === 'success' ? 'var(--green)' : 'var(--red)'}`,
						borderColor: `color-mix(in srgb, ${message.type === 'success' ? 'var(--green)' : 'var(--red)'} 30%, transparent)`,
					}}
				>
					{message.text}
				</div>
			)}

			<div style={{ display: 'flex', gap: 28, alignItems: 'flex-start' }}>
				<nav
					style={{
						position: 'sticky',
						top: 24,
						width: 172,
						flexShrink: 0,
						display: 'flex',
						flexDirection: 'column',
						gap: 2,
					}}
				>
					{sections.map(section => {
						const active = currentSection?.id === section.id
						return (
							<button
								key={section.id}
								type="button"
								onClick={() => setActiveSection(section.id)}
								style={{
									textAlign: 'left',
									padding: '7px 12px',
									border: 'none',
									borderRadius: 'var(--radius-sm)',
									background: active ? 'var(--bg-3)' : 'transparent',
									color: active ? 'var(--text-0)' : 'var(--text-3)',
									fontSize: 13,
									fontFamily: 'var(--font-sans)',
									fontWeight: active ? 600 : 400,
									cursor: 'pointer',
									transition: 'all 120ms',
								}}
							>
								{section.title}
							</button>
						)
					})}
				</nav>

				<div style={{ flex: 1, minWidth: 0 }}>
					{currentSection && (
						<Card
							title={currentSection.title}
							description={currentSection.description}
							action={sectionAction(currentSection.controls, addListItem)}
						>
							{currentSection.controls.map(control => {
								if (control.type === 'list') {
									return (
										<ConfigList
											key={control.path.join('.')}
											control={control}
											config={config}
											update={update}
											removeItem={removeListItem}
										/>
									)
								}
								return (
									<ConfigInput
										key={control.path.join('.')}
										field={control}
										value={getAtPath(config, control.path)}
										onChange={value => update(control.path, value)}
									/>
								)
							})}
						</Card>
					)}

					<div style={{ height: 40 }} />
				</div>
			</div>
		</div>
	)
}

function sectionAction(
	controls: ConfigDocument['edit']['sections'][number]['controls'],
	addListItem: (control: ConfigEditListControl) => void,
) {
	const lists = controls.filter(control => control.type === 'list')
	if (lists.length !== 1) return undefined
	const list = lists[0]
	return <SmallButton onClick={() => addListItem(list)}>{list.addLabel}</SmallButton>
}

function ConfigList({
	control,
	config,
	update,
	removeItem,
}: {
	control: ConfigEditListControl
	config: Config
	update: (path: string[], value: unknown) => void
	removeItem: (control: ConfigEditListControl, index: number) => void
}) {
	const value = getAtPath(config, control.path)
	const items = Array.isArray(value) ? (value as Array<Record<string, unknown>>) : []

	if (items.length === 0) {
		return <p style={{ color: 'var(--text-4)', fontSize: 12, padding: '8px 0' }}>{control.emptyLabel}</p>
	}

	return (
		<>
			{items.map((item, index) => (
				<div
					// biome-ignore lint/suspicious/noArrayIndexKey: rows are edited/removed by index against the saved config; no stable id exists
					key={index}
					style={{
						padding: '14px 16px',
						marginBottom: 8,
						background: 'var(--bg-0)',
						borderRadius: 'var(--radius-sm)',
						border: '1px solid var(--border)',
					}}
				>
					<div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
						<span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-2)' }}>
							{String(getAtPath(item, control.itemTitlePath) || `Item ${index + 1}`)}
						</span>
						<SmallButton onClick={() => removeItem(control, index)} danger>
							Remove
						</SmallButton>
					</div>
					{control.fields.map(field => (
						<ConfigInput
							key={field.path.join('.')}
							field={field}
							value={getAtPath(item, field.path)}
							onChange={value => update([...control.path, String(index), ...field.path], value)}
						/>
					))}
				</div>
			))}
		</>
	)
}

function ConfigInput({
	field,
	value,
	onChange,
}: {
	field: ConfigEditField
	value: unknown
	onChange: (value: unknown) => void
}) {
	if (field.input === 'select') {
		return (
			<SelectField
				label={field.label}
				value={String(value ?? '')}
				onChange={next => onChange(normalizeTextValue(String(next), field))}
				options={field.options ?? []}
			/>
		)
	}

	if (field.input === 'boolean') {
		return <Toggle label={field.label} value={Boolean(value)} onChange={onChange} />
	}

	if (field.input === 'color') {
		return (
			<ColorField
				label={field.label}
				value={String(value ?? '')}
				onChange={next => onChange(normalizeTextValue(next, field))}
			/>
		)
	}

	if (field.input === 'textarea') {
		return (
			<TextAreaField
				label={field.label}
				value={String(value ?? '')}
				onChange={next => onChange(normalizeTextValue(next, field))}
				placeholder={field.placeholder}
			/>
		)
	}

	return (
		<Field
			label={field.label}
			value={String(value ?? '')}
			onChange={next => onChange(normalizeFieldValue(next, field))}
			type={field.input === 'password' ? 'password' : field.input === 'number' ? 'number' : 'text'}
			required={field.required}
			placeholder={field.placeholder}
		/>
	)
}

function normalizeFieldValue(value: string, field: ConfigEditField): unknown {
	if (field.input === 'number') return value.trim() === '' && !field.required ? undefined : Number(value)
	return normalizeTextValue(value, field)
}

function normalizeTextValue(value: string, field: ConfigEditField): unknown {
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
		const segment = path[i]
		const nextSegment = path[i + 1]
		const existing = current[segment]
		if (typeof existing !== 'object' || existing === null) {
			current[segment] = /^\d+$/.test(nextSegment) ? [] : {}
		}
		current = current[segment] as Record<string, unknown>
	}
	const last = path[path.length - 1]
	if (value === undefined) {
		delete current[last]
	} else {
		current[last] = value
	}
}

function Card({
	title,
	description,
	action,
	children,
}: {
	title: string
	description?: string
	action?: ReactNode
	children: ReactNode
}) {
	return (
		<div
			style={{
				marginBottom: 20,
				padding: '18px 20px',
				background: 'var(--bg-1)',
				borderRadius: 'var(--radius)',
				border: '1px solid var(--border)',
			}}
		>
			<div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
				<div>
					<h2 style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-0)', marginBottom: 2 }}>{title}</h2>
					{description && <p style={{ fontSize: 11, color: 'var(--text-4)', margin: 0 }}>{description}</p>}
				</div>
				{action}
			</div>
			{children}
		</div>
	)
}

function Field({
	label,
	value,
	onChange,
	type = 'text',
	required,
	placeholder,
}: {
	label: string
	value: string
	onChange: (v: string) => void
	type?: 'text' | 'password' | 'number'
	required?: boolean
	placeholder?: string
}) {
	const empty = required && !value.trim()

	return (
		<label style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
			<span
				style={{
					fontSize: 12,
					color: 'var(--text-3)',
					width: 120,
					flexShrink: 0,
					display: 'flex',
					alignItems: 'center',
					gap: 3,
				}}
			>
				{label}
				{required && <span style={{ color: 'var(--red)', fontSize: 10 }}>*</span>}
			</span>
			<input
				type={type}
				value={value}
				placeholder={placeholder}
				onChange={e => onChange(e.target.value)}
				style={{
					flex: 1,
					padding: '6px 10px',
					background: 'var(--bg-0)',
					border: `1px solid ${empty ? 'var(--red)' : 'var(--border)'}`,
					borderRadius: 'var(--radius-sm)',
					color: 'var(--text-1)',
					fontSize: 12,
					fontFamily: type === 'number' ? 'var(--font-mono)' : 'var(--font-sans)',
					outline: 'none',
					transition: 'border-color 150ms',
				}}
				onFocus={e => {
					if (!empty) e.currentTarget.style.borderColor = 'var(--accent)'
				}}
				onBlur={e => {
					e.currentTarget.style.borderColor = empty ? 'var(--red)' : 'var(--border)'
				}}
			/>
		</label>
	)
}

/** Multi-line text editor for long values (e.g. an AI helper's instruction prompt).
 *  Blank = the built-in default, shown as the placeholder so the user sees it. */
function TextAreaField({
	label,
	value,
	onChange,
	placeholder,
}: {
	label: string
	value: string
	onChange: (v: string) => void
	placeholder?: string
}) {
	return (
		<label style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
			<span style={{ fontSize: 12, color: 'var(--text-3)' }}>{label}</span>
			<textarea
				value={value}
				placeholder={placeholder}
				rows={8}
				onChange={e => onChange(e.target.value)}
				style={{
					width: '100%',
					padding: '8px 10px',
					background: 'var(--bg-0)',
					border: '1px solid var(--border)',
					borderRadius: 'var(--radius-sm)',
					color: 'var(--text-1)',
					fontSize: 12,
					lineHeight: 1.5,
					fontFamily: 'var(--font-mono)',
					outline: 'none',
					resize: 'vertical',
					transition: 'border-color 150ms',
				}}
				onFocus={e => {
					e.currentTarget.style.borderColor = 'var(--accent)'
				}}
				onBlur={e => {
					e.currentTarget.style.borderColor = 'var(--border)'
				}}
			/>
		</label>
	)
}

function SelectField({
	label,
	value,
	onChange,
	options,
}: {
	label: string
	value: string
	onChange: (v: string) => void
	options: Array<{ value: string; label: string }>
}) {
	return (
		<label style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
			<span style={{ fontSize: 12, color: 'var(--text-3)', width: 120, flexShrink: 0 }}>{label}</span>
			<select
				value={value}
				onChange={e => onChange(e.target.value)}
				style={{
					flex: 1,
					padding: '6px 10px',
					background: 'var(--bg-0)',
					border: '1px solid var(--border)',
					borderRadius: 'var(--radius-sm)',
					color: 'var(--text-1)',
					fontSize: 12,
					fontFamily: 'var(--font-sans)',
					outline: 'none',
					transition: 'border-color 150ms',
				}}
				onFocus={e => {
					e.currentTarget.style.borderColor = 'var(--accent)'
				}}
				onBlur={e => {
					e.currentTarget.style.borderColor = 'var(--border)'
				}}
			>
				{options.map(option => (
					<option key={option.value} value={option.value}>
						{option.label}
					</option>
				))}
			</select>
		</label>
	)
}

function ColorField({
	label,
	value,
	onChange,
}: {
	label: string
	value: string
	onChange: (v: string) => void
}) {
	return (
		<label style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
			<span style={{ fontSize: 12, color: 'var(--text-3)', width: 120, flexShrink: 0 }}>{label}</span>
			<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
				<input
					type="color"
					value={value || '#808080'}
					onChange={e => onChange(e.target.value)}
					style={{
						width: 32,
						height: 24,
						padding: 0,
						border: '1px solid var(--border)',
						borderRadius: 'var(--radius-sm)',
						background: 'var(--bg-0)',
						cursor: 'pointer',
					}}
				/>
				{value && (
					<button
						type="button"
						onClick={() => onChange('')}
						style={{
							background: 'none',
							border: 'none',
							color: 'var(--text-4)',
							cursor: 'pointer',
							fontSize: 11,
							fontFamily: 'var(--font-sans)',
						}}
					>
						Clear
					</button>
				)}
			</div>
		</label>
	)
}

function Toggle({
	label,
	value,
	onChange,
	description,
}: {
	label: string
	value: boolean
	onChange: (v: boolean) => void
	description?: string
}) {
	return (
		<div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
			<span style={{ fontSize: 12, color: 'var(--text-3)', width: 120, flexShrink: 0 }}>{label}</span>
			<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
				<button
					type="button"
					aria-label={label}
					onClick={() => onChange(!value)}
					style={{
						width: 36,
						height: 20,
						borderRadius: 10,
						border: 'none',
						cursor: 'pointer',
						background: value ? 'var(--accent)' : 'var(--bg-3)',
						position: 'relative',
						transition: 'background 150ms',
						flexShrink: 0,
					}}
				>
					<span
						style={{
							position: 'absolute',
							top: 2,
							left: value ? 18 : 2,
							width: 16,
							height: 16,
							borderRadius: '50%',
							background: '#fff',
							transition: 'left 150ms',
						}}
					/>
				</button>
				{description && <span style={{ fontSize: 11, color: 'var(--text-4)' }}>{description}</span>}
			</div>
		</div>
	)
}

function SmallButton({
	onClick,
	children,
	danger,
}: {
	onClick: () => void
	children: ReactNode
	danger?: boolean
}) {
	const color = danger ? 'var(--red)' : 'var(--accent)'
	return (
		<button
			type="button"
			onClick={onClick}
			style={{
				padding: '3px 10px',
				background: 'none',
				border: `1px solid color-mix(in srgb, ${color} 40%, transparent)`,
				borderRadius: 'var(--radius-sm)',
				color,
				cursor: 'pointer',
				fontSize: 11,
				fontFamily: 'var(--font-sans)',
				fontWeight: 500,
				transition: 'all 150ms',
			}}
			onMouseEnter={e => {
				e.currentTarget.style.background = `color-mix(in srgb, ${color} 10%, transparent)`
			}}
			onMouseLeave={e => {
				e.currentTarget.style.background = 'none'
			}}
		>
			{children}
		</button>
	)
}
