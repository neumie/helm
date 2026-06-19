import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'

type Config = Record<string, unknown>

export function SettingsPage() {
	const [config, setConfig] = useState<Config | null>(null)
	const [saving, setSaving] = useState(false)
	const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
	const [dirty, setDirty] = useState(false)

	useEffect(() => {
		api
			.configFull()
			.then(setConfig)
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
			let obj: Record<string, unknown> = next
			for (let i = 0; i < path.length - 1; i++) {
				if (obj[path[i]] === undefined || obj[path[i]] === null) {
					obj[path[i]] = {}
				}
				obj = obj[path[i]] as Record<string, unknown>
			}
			obj[path[path.length - 1]] = value
			return next
		})
	}, [])

	const addProject = useCallback(() => {
		setDirty(true)
		setConfig(prev => {
			if (!prev) return prev
			const next = structuredClone(prev)
			const projects = (next.projects as Array<Record<string, unknown>>) ?? []
			projects.push({ slug: '', repoPath: '', baseBranch: 'main' })
			next.projects = projects
			return next
		})
	}, [])

	const removeProject = useCallback((index: number) => {
		setDirty(true)
		setConfig(prev => {
			if (!prev) return prev
			const next = structuredClone(prev)
			const projects = (next.projects as Array<Record<string, unknown>>) ?? []
			projects.splice(index, 1)
			next.projects = projects
			return next
		})
	}, [])

	if (!config) {
		return <div style={{ padding: 40, color: 'var(--text-3)' }}>{message ? message.text : 'Loading config...'}</div>
	}

	const provider = config.provider as Record<string, unknown> | undefined
	const projects = config.projects as Array<Record<string, unknown>> | undefined
	const polling = config.polling as Record<string, unknown> | undefined
	const solver = config.solver as Record<string, unknown> | undefined
	const server = config.server as Record<string, unknown> | undefined
	const github = config.github as Record<string, unknown> | undefined

	return (
		<div style={{ maxWidth: 680, margin: '0 auto', padding: '32px 24px' }}>
			{/* Header */}
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

			{/* Provider */}
			{provider && (
				<Card title="Provider" description="External task source configuration">
					<Field
						label="Type"
						value={String(provider.type ?? '')}
						onChange={v => update(['provider', 'type'], v)}
						required
					/>
					<Field
						label="API Base URL"
						value={String(provider.apiBaseUrl ?? '')}
						onChange={v => update(['provider', 'apiBaseUrl'], v)}
						required
						placeholder="https://..."
					/>
					<Field
						label="Project Slug"
						value={String(provider.projectSlug ?? '')}
						onChange={v => update(['provider', 'projectSlug'], v)}
						required
					/>
					<Field
						label="API Token"
						value={String(provider.apiToken ?? '')}
						onChange={v => update(['provider', 'apiToken'], v)}
						type="password"
						required
					/>
					<Field
						label="Task Base URL"
						value={String(provider.taskBaseUrl ?? '')}
						onChange={v => update(['provider', 'taskBaseUrl'], v || undefined)}
						placeholder="https://... (optional)"
					/>
				</Card>
			)}

			{/* Projects */}
			<Card
				title="Projects"
				description="Repositories that Vigil monitors and solves tasks for"
				action={<SmallButton onClick={addProject}>+ Add project</SmallButton>}
			>
				{(projects ?? []).length === 0 && (
					<p style={{ color: 'var(--text-4)', fontSize: 12, padding: '8px 0' }}>No projects configured.</p>
				)}
				{(projects ?? []).map((p, i) => (
					<div
						// biome-ignore lint/suspicious/noArrayIndexKey: rows are edited/removed by index against the saved config; no stable id exists
						key={i}
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
								{String(p.slug || `Project ${i + 1}`)}
							</span>
							<SmallButton onClick={() => removeProject(i)} danger>
								Remove
							</SmallButton>
						</div>
						<Field
							label="Slug"
							value={String(p.slug ?? '')}
							onChange={v => update(['projects', String(i), 'slug'], v)}
							required
						/>
						<Field
							label="Repo Path"
							value={String(p.repoPath ?? '')}
							onChange={v => update(['projects', String(i), 'repoPath'], v)}
							required
							placeholder="/path/to/repo"
						/>
						<Field
							label="Base Branch"
							value={String(p.baseBranch ?? 'main')}
							onChange={v => update(['projects', String(i), 'baseBranch'], v)}
						/>
						<Field
							label="Worktree Dir"
							value={String(p.worktreeDir ?? '')}
							onChange={v => update(['projects', String(i), 'worktreeDir'], v || undefined)}
							placeholder="(optional)"
						/>
						<ColorField
							label="Color"
							value={String(p.color ?? '')}
							onChange={v => update(['projects', String(i), 'color'], v || undefined)}
						/>
					</div>
				))}
			</Card>

			{/* Polling */}
			<Card title="Polling" description="How often Vigil checks for new tasks">
				<Field
					label="Interval (seconds)"
					value={String(polling?.intervalSeconds ?? 60)}
					onChange={v => update(['polling', 'intervalSeconds'], Number(v))}
					type="number"
					required
				/>
				<Field
					label="Since"
					value={String(polling?.since ?? '')}
					onChange={v => update(['polling', 'since'], v || undefined)}
					placeholder="ISO date (optional)"
				/>
			</Card>

			{/* Solver */}
			<Card title="Solver" description="Agent invocation settings">
				<SelectField
					label="Type"
					value={String(solver?.type ?? 'default')}
					onChange={v => update(['solver', 'type'], v)}
					options={[
						{ value: 'default', label: 'Default' },
						{ value: 'okena', label: 'Okena' },
					]}
				/>
				<SelectField
					label="Agent"
					value={String(solver?.agent ?? 'claude')}
					onChange={v => update(['solver', 'agent'], v)}
					options={[
						{ value: 'claude', label: 'Claude Code' },
						{ value: 'codex', label: 'Codex' },
					]}
				/>
				<Field
					label="Concurrency"
					value={String(solver?.concurrency ?? 2)}
					onChange={v => update(['solver', 'concurrency'], Number(v))}
					type="number"
				/>
				<Field
					label="Model"
					value={String(solver?.model ?? '')}
					onChange={v => update(['solver', 'model'], v || undefined)}
					placeholder="Agent model override (optional)"
				/>
				<Field
					label="Timeout (min)"
					value={String(solver?.timeoutMinutes ?? 30)}
					onChange={v => update(['solver', 'timeoutMinutes'], Number(v))}
					type="number"
				/>
				<Field
					label="Max Budget ($)"
					value={String(solver?.maxBudgetUsd ?? '')}
					onChange={v => update(['solver', 'maxBudgetUsd'], v ? Number(v) : undefined)}
					type="number"
					placeholder="(optional)"
				/>
				<Field
					label="Transformer"
					value={String(solver?.transformer ?? 'default')}
					onChange={v => update(['solver', 'transformer'], v)}
				/>
			</Card>

			{/* Server */}
			<Card title="Server" description="Dashboard and API server">
				<Field
					label="Port"
					value={String(server?.port ?? 7474)}
					onChange={v => update(['server', 'port'], Number(v))}
					type="number"
				/>
				<Field label="Host" value={String(server?.host ?? 'localhost')} onChange={v => update(['server', 'host'], v)} />
			</Card>

			{/* GitHub */}
			<Card title="GitHub" description="PR and comment settings">
				<Toggle
					label="Create PRs"
					value={Boolean(github?.createPrs ?? true)}
					onChange={v => update(['github', 'createPrs'], v)}
				/>
				<Toggle
					label="Post Comments"
					value={Boolean(github?.postComments ?? true)}
					onChange={v => update(['github', 'postComments'], v)}
				/>
				<Field
					label="PR Prefix"
					value={String(github?.prPrefix ?? '[Vigil]')}
					onChange={v => update(['github', 'prPrefix'], v)}
				/>
			</Card>

			{/* Bottom spacing */}
			<div style={{ height: 40 }} />
		</div>
	)
}

// --- Components ---

function Card({
	title,
	description,
	action,
	children,
}: {
	title: string
	description?: string
	action?: React.ReactNode
	children: React.ReactNode
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
	children: React.ReactNode
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
