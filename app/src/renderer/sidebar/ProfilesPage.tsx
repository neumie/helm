import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ProfileKnowledgeBinding, ProfilesDocument } from '../../shared-helm'
import { showToast } from '../toast'
import { ActionRow, Btn, Card, EmptyState, PushHeader, SelectInput, TextInput, Toggle } from './ui'

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

function useProfiles() {
	const [document, setDocument] = useState<ProfilesDocument | null>(null)
	const [error, setError] = useState<string | null>(null)
	const load = useCallback(async () => {
		const result = await window.helm.profiles.list()
		if (result.error !== undefined) {
			setError(result.error)
			return null
		}
		setDocument(result.data)
		setError(null)
		return result.data
	}, [])
	useEffect(() => {
		void load()
	}, [load])
	return { document, error, load }
}

export function ProfilesPage({ onBack, onOpen }: { onBack: () => void; onOpen: (profileId: string) => void }) {
	const { document, error, load } = useProfiles()
	const [creating, setCreating] = useState(false)
	const create = async () => {
		if (!document || creating) return
		setCreating(true)
		const result = await window.helm.profiles.create('New profile', document.configuredProjects)
		setCreating(false)
		if (result.error !== undefined) {
			showToast({ message: result.error })
			return
		}
		await load()
		onOpen(result.data.profile.id)
	}
	return (
		<div className="page-frame">
			<PushHeader
				title="Profiles"
				onBack={onBack}
				trailing={
					<Btn sm busy={creating} onClick={() => void create()}>
						Add
					</Btn>
				}
			/>
			<div className="page-scroll">
				<p className="section-description">
					Items and terminals stay separate. Configuration and appearance are shared.
				</p>
				{error ? (
					<EmptyState title="Profiles unavailable" detail={error} />
				) : !document ? (
					<EmptyState title="Loading profiles" detail="Fetching the active workspace." />
				) : (
					<>
						<Card label="Profiles" flush>
							{document.profiles
								.filter(profile => profile.archivedAt === null)
								.map(profile => (
									<ActionRow
										key={profile.id}
										nav
										label={profile.name}
										value={
											profile.id === document.activeProfileId ? 'Active' : `${profile.enabledProjects.length} projects`
										}
										onClick={() => onOpen(profile.id)}
									/>
								))}
						</Card>
						{document.profiles.some(profile => profile.archivedAt !== null) && (
							<Card label="Archived" flush>
								{document.profiles
									.filter(profile => profile.archivedAt !== null)
									.map(profile => (
										<ActionRow
											key={profile.id}
											nav
											label={profile.name}
											value="Archived"
											onClick={() => onOpen(profile.id)}
										/>
									))}
							</Card>
						)}
					</>
				)}
			</div>
		</div>
	)
}

export function ProfileEditorPage({ profileId, onBack }: { profileId: string; onBack: () => void }) {
	const { document, error, load } = useProfiles()
	const profile = useMemo(
		() => document?.profiles.find(candidate => candidate.id === profileId) ?? null,
		[document, profileId],
	)
	const [name, setName] = useState('')
	const [enabledProjects, setEnabledProjects] = useState<string[]>([])
	const [knowledgeBindings, setKnowledgeBindings] = useState<ProfileKnowledgeBinding[]>([])
	const [busy, setBusy] = useState(false)
	useEffect(() => {
		if (!profile) return
		setName(profile.name)
		setEnabledProjects(profile.enabledProjects)
		setKnowledgeBindings(profile.knowledgeBindings)
	}, [profile])

	const mutate = async (operation: () => Promise<{ error?: string }>, success: string) => {
		setBusy(true)
		try {
			const result = await operation()
			if (result.error !== undefined) {
				showToast({ message: result.error })
				return false
			}
			showToast({ message: success })
			await load()
			return true
		} catch (err) {
			showToast({ message: errorMessage(err) })
			return false
		} finally {
			setBusy(false)
		}
	}

	if (error || (document && !profile)) {
		return (
			<div className="page-frame">
				<PushHeader title="Profile" onBack={onBack} />
				<EmptyState title="Profile unavailable" detail={error ?? 'This profile no longer exists.'} />
			</div>
		)
	}
	if (!document || !profile) {
		return (
			<div className="page-frame">
				<PushHeader title="Profile" onBack={onBack} />
				<EmptyState title="Loading profile" detail="Fetching profile settings." />
			</div>
		)
	}
	const active = profile.id === document.activeProfileId
	const archived = profile.archivedAt !== null
	const sortedBindings = (bindings: ProfileKnowledgeBinding[]) =>
		[...bindings].sort((left, right) => left.projectSlug.localeCompare(right.projectSlug))
	const dirty =
		name.trim() !== profile.name ||
		JSON.stringify([...enabledProjects].sort()) !== JSON.stringify([...profile.enabledProjects].sort()) ||
		JSON.stringify(sortedBindings(knowledgeBindings)) !== JSON.stringify(sortedBindings(profile.knowledgeBindings))
	const validBindings = knowledgeBindings.every(
		binding =>
			binding.providerProjectId.trim().length > 0 &&
			binding.characterBudget >= 100 &&
			binding.characterBudget <= 200_000,
	)
	const toggleProject = (project: string, enabled: boolean) => {
		setEnabledProjects(current =>
			enabled ? [...new Set([...current, project])] : current.filter(candidate => candidate !== project),
		)
		if (!enabled) setKnowledgeBindings(current => current.filter(binding => binding.projectSlug !== project))
	}
	const setBindingProvider = (projectSlug: string, providerId: string) => {
		setKnowledgeBindings(current => {
			const withoutProject = current.filter(binding => binding.projectSlug !== projectSlug)
			if (!providerId) return withoutProject
			const existing = current.find(binding => binding.projectSlug === projectSlug)
			return [
				...withoutProject,
				{
					projectSlug,
					providerId,
					providerProjectId: existing?.providerProjectId ?? '',
					characterBudget: existing?.characterBudget ?? 20_000,
					allowSharedProject: existing?.allowSharedProject ?? false,
				},
			]
		})
	}
	const updateBinding = (projectSlug: string, patch: Partial<ProfileKnowledgeBinding>) =>
		setKnowledgeBindings(current =>
			current.map(binding => (binding.projectSlug === projectSlug ? { ...binding, ...patch } : binding)),
		)
	return (
		<div className="page-frame">
			<PushHeader title={profile.name} onBack={onBack} />
			<div className="page-scroll">
				<div className="settings-field">
					<label className="field-label" htmlFor="profile-name">
						Name
					</label>
					<TextInput id="profile-name" value={name} onChange={setName} />
				</div>
				<Card label="Projects" flush>
					{document.configuredProjects.map(project => (
						<div className="profile-project-row" key={project}>
							<span>{project}</span>
							<Toggle
								label={`Enable ${project}`}
								value={enabledProjects.includes(project)}
								onChange={value => toggleProject(project, value)}
							/>
						</div>
					))}
				</Card>
				<Card label="Project knowledge">
					<p className="section-description">
						Each enabled project may map explicitly to one external knowledge project. No mapping means disabled.
					</p>
					{enabledProjects.map(project => {
						const binding = knowledgeBindings.find(candidate => candidate.projectSlug === project)
						return (
							<div className="settings-field" key={project}>
								<label className="field-label" htmlFor={`knowledge-provider-${project}`}>
									{project}
								</label>
								<SelectInput
									id={`knowledge-provider-${project}`}
									value={binding?.providerId ?? ''}
									onChange={providerId => setBindingProvider(project, providerId)}
									options={[
										{ value: '', label: 'No knowledge provider' },
										...document.configuredKnowledgeProviders.map(provider => ({
											value: provider.id,
											label: `${provider.id} (${provider.type})`,
										})),
									]}
								/>
								{binding && (
									<>
										<label className="field-label" htmlFor={`knowledge-project-${project}`}>
											{project} provider project ID
										</label>
										<TextInput
											id={`knowledge-project-${project}`}
											value={binding.providerProjectId}
											placeholder="Opaque provider project ID"
											onChange={providerProjectId => updateBinding(project, { providerProjectId })}
										/>
										<input
											className="input"
											type="number"
											min={100}
											max={200000}
											value={binding.characterBudget}
											aria-label={`${project} knowledge character budget`}
											onChange={event => updateBinding(project, { characterBudget: Number(event.target.value) })}
										/>
										<div className="profile-project-row">
											<span>Allow this knowledge project in another profile</span>
											<Toggle
												label={`Allow ${project} knowledge sharing`}
												value={binding.allowSharedProject}
												onChange={allowSharedProject => updateBinding(project, { allowSharedProject })}
											/>
										</div>
									</>
								)}
							</div>
						)
					})}
				</Card>
				<div className="profile-actions">
					{!archived && (
						<Btn
							tone="primary"
							block
							busy={busy}
							disabled={!dirty || !name.trim() || !validBindings}
							onClick={() =>
								void mutate(
									() =>
										window.helm.profiles.update(profile.id, {
											name: name.trim(),
											enabledProjects,
											knowledgeBindings,
										}),
									'Profile saved',
								)
							}
						>
							Save profile
						</Btn>
					)}
					{!active && !archived && (
						<Btn
							block
							disabled={busy || dirty}
							onClick={() => void mutate(() => window.helm.profiles.activate(profile.id), 'Switching profiles…')}
						>
							Switch to this profile
						</Btn>
					)}
					{!active && !archived && (
						<Btn
							tone="danger"
							block
							disabled={busy}
							onClick={() => void mutate(() => window.helm.profiles.archive(profile.id), 'Profile archived')}
						>
							Archive profile
						</Btn>
					)}
					{archived && (
						<Btn
							block
							busy={busy}
							onClick={() => void mutate(() => window.helm.profiles.restore(profile.id), 'Profile restored')}
						>
							Restore profile
						</Btn>
					)}
				</div>
			</div>
		</div>
	)
}
