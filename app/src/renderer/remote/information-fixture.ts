import type { InformationResponse } from '../../../../src/remote/information-protocol.js'
import type { InformationTarget } from './transport.js'

/** Display-only source data; never native sampling or installed-exporter proof. */
export function informationFixture(owner: InformationTarget): InformationResponse {
	return {
		version: 1,
		...owner,
		status: 'available',
		freshForMs: 5000,
		information: {
			version: 1,
			...owner,
			sequence: 1,
			footer: {
				availability: 'available',
				fields: {
					cwd: 'helm',
					trusted: false,
					sessionName: null,
					model: 'GPT model',
					thinking: 'high',
					inputTokens: 0,
					outputTokens: 120,
					contextTokens: 120,
					contextWindow: 200000,
					contextPercent: 0,
					goalAvailable: false,
					goalPhase: null,
					omittedStatuses: 2,
					omitted: 1,
				},
			},
			sidebar: {
				availability: 'available',
				omittedProviders: 1,
				sections: [
					{
						title: 'Goal',
						scope: 'session',
						availability: 'available',
						coverage: 'complete',
						omitted: 0,
						rows: [
							{ label: 'Objective', value: 'Make available extension information readable' },
							{ label: 'Phase', value: 'active' },
							{ label: 'Work', value: 'Implement browser presentation' },
							{ label: 'Review', value: 'Focused verification' },
							{ label: 'Reason', value: null },
						],
					},
					{
						title: 'Todos',
						scope: 'session',
						availability: 'available',
						coverage: 'limited',
						omitted: 2,
						rows: [
							{ label: 'In progress', value: 'Verify information expiry' },
							{ label: 'Completed', value: 'Bound the browser decoder' },
						],
					},
					{
						title: 'Jobs',
						scope: 'session',
						availability: 'available',
						coverage: 'limited',
						omitted: 0,
						rows: [{ label: 'Attributed jobs', value: 0 }],
					},
					{
						title: 'Updates',
						scope: 'process',
						availability: 'available',
						coverage: 'complete',
						omitted: 0,
						rows: [
							{ label: 'Available updates', value: 0 },
							{ label: 'Checking', value: false },
						],
					},
					{
						title: 'Integration',
						scope: 'session',
						availability: 'available',
						coverage: 'complete',
						omitted: 0,
						rows: [],
					},
					{
						title: 'Language server',
						scope: 'session',
						availability: 'unavailable',
						coverage: 'unavailable',
						omitted: 0,
						rows: [],
					},
					{
						title: 'Subagent fleet',
						scope: 'session',
						availability: 'unsupported',
						coverage: 'unavailable',
						omitted: 0,
						rows: [],
					},
				],
			},
		},
	}
}
