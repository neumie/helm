import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import type { HelmApi } from '../../shared'
import type {
	ConfigDocument,
	HelmResult,
	ProfilesDocument,
	ScheduledSchedule,
	ScheduledScheduleInput,
} from '../../shared-helm'
import { ProfileEditorPage } from './ProfilesPage'
import { ScheduledRunEditorPage } from './ScheduledRunsPage'
import { SettingsSectionPage, useSettingsStore } from './SettingsPage'
import { Btn } from './ui'

// Explicit held IO around the real editors; never installed into Electron.
const now = '2026-07-21T12:00:00.000Z'
const config: ConfigDocument = {
	config: { solver: { concurrency: 2 } },
	dashboard: {},
	secretRedaction: '••••••••',
	edit: {
		sections: [
			{
				id: 'run-limits',
				title: 'Run limits',
				description: 'Held save fixture.',
				controls: [
					{ type: 'field', path: ['solver', 'concurrency'], label: 'Agent runs', input: 'number', required: true },
				],
			},
		],
	},
}
const initialSchedule: ScheduledSchedule = {
	id: 'schedule-a',
	profileId: 'work',
	revision: 1,
	name: 'Daily review',
	enabled: true,
	target: { kind: 'system' },
	agent: 'claude',
	maximumRuntimeMinutes: 30,
	cron: '0 9 * * *',
	cadenceKind: 'daily',
	timezone: 'UTC',
	nextRunAt: null,
	disabledReason: null,
	archivedAt: null,
	createdAt: now,
	updatedAt: now,
}

type Harness = {
	requests: Array<{ kind: string; body: unknown }>
	pending: number
	back: number
	release: (fail?: boolean, index?: number) => void
	replaceApi: () => void
}
type FixtureWindow = Window & { __editors?: Harness }

function installFixture() {
	let schedule = structuredClone(initialSchedule)
	let document: ProfilesDocument = {
		version: 2,
		generation: 1,
		activeProfileId: 'work',
		configuredProjects: ['helm'],
		configuredKnowledgeProviders: [],
		profiles: [
			{ id: 'work', name: 'Work', createdAt: now, archivedAt: null, enabledProjects: ['helm'], knowledgeBindings: [] },
		],
	}
	const completions: Array<(fail: boolean) => void> = []
	const harness: Harness = {
		requests: [],
		pending: 0,
		back: 0,
		release(fail = false, index = 0) {
			completions.splice(index, 1)[0]?.(fail)
		},
		replaceApi() {
			window.helm = { ...window.helm, daemon: { ...window.helm.daemon }, profiles: { ...window.helm.profiles } }
		},
	}
	function held<T>(kind: string, body: unknown, complete: () => T): Promise<HelmResult<T>> {
		harness.requests.push({ kind, body: structuredClone(body) })
		harness.pending++
		return new Promise(resolve =>
			completions.push(fail => {
				harness.pending--
				resolve(fail ? { error: 'Fixture save failed' } : { data: complete() })
			}),
		)
	}
	const saveSchedule = (body: ScheduledScheduleInput, revision: number) => {
		schedule = {
			...schedule,
			name: body.name,
			enabled: body.enabled,
			target: body.definition.target,
			agent: body.definition.agent,
			maximumRuntimeMinutes: body.definition.maximumRuntimeMinutes,
			cron: body.cron,
			cadenceKind: body.cadenceKind,
			timezone: body.timezone,
			revision,
		}
		return structuredClone(schedule)
	}
	window.helm = {
		daemon: {
			config: async () => ({ data: structuredClone(config) }),
			restartDaemon: () => held('restart', {}, () => ({ applied: true, message: 'Restart admitted' })),
			updateConfig: (body: Record<string, unknown>) =>
				held('settings', body, () => ({ applied: false, message: 'Fixture restart required' })),
			loadScheduledRun: async () => ({ data: { ...schedule, prompt: 'Original prompt' } }),
			scheduledRunHistory: async () => ({ data: [] }),
			updateScheduledRun: (_profile: string, _id: string, body: ScheduledScheduleInput & { revision: number }) =>
				held('schedule-update', body, () => saveSchedule(body, body.revision + 1)),
			createScheduledRun: (_profile: string, body: ScheduledScheduleInput) =>
				held('schedule-create', body, () => saveSchedule(body, 1)),
		},
		profiles: {
			list: async () => ({ data: structuredClone(document) }),
			update: (id: string, body: Partial<ProfilesDocument['profiles'][number]>) =>
				held('profile', body, () => {
					document = {
						...document,
						profiles: document.profiles.map(profile => (profile.id === id ? { ...profile, ...body } : profile)),
					}
					return { profile: document.profiles[0], state: document }
				}),
		},
	} as unknown as HelmApi
	;(window as FixtureWindow).__editors = harness
	return harness
}

function SettingsFixture() {
	const store = useSettingsStore(true)
	return <SettingsSectionPage store={store} sectionId="run-limits" onBack={() => {}} />
}
function EditorFixture({ kind }: { kind: 'settings' | 'profile' | 'schedule' | 'create' }) {
	const [harness] = useState(installFixture)
	const [version, setVersion] = useState(0)
	const [open, setOpen] = useState(true)
	return (
		<div className="sidebar" style={{ width: 340, height: '100vh' }}>
			<Btn
				onClick={() => {
					harness.replaceApi()
					setVersion(value => value + 1)
				}}
			>
				Replace fixture API
			</Btn>
			<Btn onClick={() => setOpen(value => !value)}>Toggle editor mount</Btn>
			<div className="page-frame" data-fixture-version={version}>
				{open &&
					(kind === 'settings' ? (
						<SettingsFixture />
					) : kind === 'profile' ? (
						<ProfileEditorPage
							profileId="work"
							onBack={() => {
								harness.back++
							}}
						/>
					) : (
						<ScheduledRunEditorPage
							profileId="work"
							scheduleId={kind === 'schedule' ? 'schedule-a' : undefined}
							config={{ projects: [{ slug: 'helm' }], scheduledRuns: { enabled: true, systemTargetsEnabled: true } }}
							onBack={() => {
								harness.back++
							}}
						/>
					))}
			</div>
		</div>
	)
}

export default { title: 'Views/Editors maintenance', parameters: { layout: 'fullscreen' } } satisfies Meta
export const SettingsSave: StoryObj = { render: () => <EditorFixture kind="settings" /> }
export const ProfileSave: StoryObj = { render: () => <EditorFixture kind="profile" /> }
export const ScheduleSave: StoryObj = { render: () => <EditorFixture kind="schedule" /> }
export const ScheduleCreate: StoryObj = { render: () => <EditorFixture kind="create" /> }
