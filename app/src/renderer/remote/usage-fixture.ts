import type { UsageResponse } from '../../../../src/remote/usage-protocol.js'
import type { RemoteTransport } from './transport.js'

const FIXTURE_EPOCH = '00000000-0000-4000-8000-0000000000aa'

/** Fixed offsets keep the rendered "resets in …" text stable for stories and browser tests. */
export function usageFixture(hostEpoch: string, now: number): UsageResponse {
	return {
		hostEpoch,
		refreshedAt: now,
		providers: [
			{
				id: 'claude',
				name: 'Claude Code',
				plan: 'max',
				windows: [
					{
						label: '5-hour',
						usedPercent: 23,
						resetsAt: now + 2 * 3600_000 + 50 * 60_000,
						windowSeconds: 5 * 3600,
						elapsedPercent: 43,
					},
					{
						label: 'Weekly',
						usedPercent: 14,
						resetsAt: now + 4 * 86_400_000,
						windowSeconds: 7 * 86_400,
						elapsedPercent: 41,
					},
				],
				source: 'live',
				observedAt: now,
				message: null,
			},
			{
				id: 'codex',
				name: 'Codex',
				plan: 'pro',
				windows: [
					{
						label: 'Weekly',
						usedPercent: 91,
						resetsAt: now + 3 * 86_400_000,
						windowSeconds: 7 * 86_400,
						elapsedPercent: 57,
					},
				],
				source: 'local',
				observedAt: now - 5 * 3600_000,
				message: null,
			},
		],
	}
}

/** Display-only service for stories and browser tests; it proves rendering, never the provider wire. */
export function enableUsageFixture(transport: RemoteTransport, variant: 'ready' | 'signed-out' = 'ready'): void {
	transport.usage = async () =>
		variant === 'ready' ? usageFixture(FIXTURE_EPOCH, Date.now()) : signedOutUsageFixture(FIXTURE_EPOCH, Date.now())
}

export function signedOutUsageFixture(hostEpoch: string, now: number): UsageResponse {
	return {
		hostEpoch,
		refreshedAt: now,
		providers: [
			{
				id: 'claude',
				name: 'Claude Code',
				plan: null,
				windows: [],
				source: null,
				observedAt: null,
				message: 'Sign in to Claude Code on this Mac to show its limits.',
			},
		],
	}
}
