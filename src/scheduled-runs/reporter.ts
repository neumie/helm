#!/usr/bin/env node

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SCHEDULED_REPORT_SUMMARY_MAX_BYTES } from './schema.js'

export interface ScheduledReporterEnvironment {
	daemonUrl?: string
	runId?: string
	reportCapability?: string
}

export interface ScheduledReportInput {
	status: 'quiet' | 'needs_attention'
	summary: string
}

/** Parse the tiny agent-facing argv surface; all authority comes from private env vars. */
export function parseScheduledReporterArgs(args: readonly string[]): ScheduledReportInput {
	const [status, ...summaryParts] = args
	if (status !== 'quiet' && status !== 'needs_attention') {
		throw new Error('Usage: helm-scheduled-reporter <quiet|needs_attention> <summary>')
	}
	const summary = summaryParts.join(' ').trim()
	if (!summary || Buffer.byteLength(summary, 'utf8') > SCHEDULED_REPORT_SUMMARY_MAX_BYTES) {
		throw new Error(`Scheduled report summary must be 1-${SCHEDULED_REPORT_SUMMARY_MAX_BYTES} UTF-8 bytes`)
	}
	return { status, summary }
}

/** Thin transport helper: no config, DB, filesystem, or control-token access. */
export async function reportScheduledRun(
	input: ScheduledReportInput,
	environment: ScheduledReporterEnvironment = {
		daemonUrl: process.env.HELM_SCHEDULED_DAEMON_URL,
		runId: process.env.HELM_SCHEDULED_RUN_ID,
		reportCapability: process.env.HELM_SCHEDULED_REPORT_CAPABILITY,
	},
	fetchImpl: typeof fetch = fetch,
): Promise<void> {
	if (!environment.daemonUrl || !environment.runId || !environment.reportCapability) {
		throw new Error('Scheduled reporter is missing its private run environment')
	}
	if (!/^[A-Za-z0-9_-]{43}$/.test(environment.reportCapability)) {
		throw new Error('Scheduled reporter capability is invalid')
	}
	const endpoint = new URL(`/api/scheduled-runs/${encodeURIComponent(environment.runId)}/report`, environment.daemonUrl)
	const response = await fetchImpl(endpoint, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${environment.reportCapability}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(input),
	})
	if (!response.ok) throw new Error(`Scheduled report failed (${response.status})`)
}

async function main(): Promise<void> {
	const input = parseScheduledReporterArgs(process.argv.slice(2))
	await reportScheduledRun(input)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
	main().catch(error => {
		process.stderr.write(`scheduled reporter failed: ${error instanceof Error ? error.message : String(error)}\n`)
		process.exitCode = 1
	})
}
