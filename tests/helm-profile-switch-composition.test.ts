import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

function run(command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise(resolve => {
		execFile(command, args, { timeout: 120_000 }, (error, stdout, stderr) => {
			resolve({ code: error && typeof error.code === 'number' ? error.code : 0, stdout, stderr })
		})
	})
}

test('profile-switch attestation is a black-box Electron/dtach evidence contract', async () => {
	const root = mkdtempSync(join(tmpdir(), 'helm-profile-composition-'))
	const evidencePath = join(root, 'evidence.json')
	try {
		const result = await run(process.execPath, ['app/scripts/profile-switch-attestation.mjs', `--output=${evidencePath}`])
		const evidence = JSON.parse(readFileSync(evidencePath, 'utf8')) as {
			result: 'passed' | 'failed' | 'skipped'
			skipReason?: string
			assertions?: Record<string, boolean>
			daemon?: { activationCalls: string[]; readyProfiles: string[]; mixedSnapshotObserved: boolean }
			window?: { sameBrowserWindow: boolean; sameWebContents: boolean; reloadCount: number }
			workSession?: {
				socketProbeBefore: string
				socketProbeAfter: string
				oldAttachClientDetached: boolean
				attachClientReplaced: boolean
				newAttachClientAlive: boolean
				preservedMasterPids: number[]
			}
			buffer?: { snapshotContainsMarkerAfterFlush: boolean; snapshotContainsMarkerAfterReturn: boolean; rendererMarkerVisibleAfterReturn: boolean }
			cleanup?: { electronExited: boolean; fakeDaemonClosed: boolean; harnessSocketHoldersTerminated: boolean; tempRootRemoved: boolean }
		}
		if (evidence.result === 'skipped') {
			assert.equal(result.code, 0, result.stderr)
			assert.match(evidence.skipReason ?? '', /macOS|Electron|dtach|built/)
			return
		}
		assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`)
		assert.equal(evidence.result, 'passed')
		assert.deepEqual(evidence.daemon?.activationCalls, ['profile-aaaaaaaaaaaa', 'work'])
		assert.deepEqual(evidence.daemon?.readyProfiles, ['profile-aaaaaaaaaaaa', 'work'])
		assert.equal(evidence.daemon?.mixedSnapshotObserved, false)
		assert.equal(evidence.window?.sameBrowserWindow, true)
		assert.equal(evidence.window?.sameWebContents, true)
		assert.equal(evidence.window?.reloadCount, 2)
		assert.equal(evidence.workSession?.socketProbeBefore, 'live')
		assert.equal(evidence.workSession?.socketProbeAfter, 'live')
		assert.equal(evidence.workSession?.oldAttachClientDetached, true)
		assert.equal(evidence.workSession?.attachClientReplaced, true)
		assert.equal(evidence.workSession?.newAttachClientAlive, true)
		assert.ok((evidence.workSession?.preservedMasterPids.length ?? 0) > 0)
		assert.deepEqual(evidence.buffer, {
			snapshotContainsMarkerAfterFlush: true,
			snapshotContainsMarkerAfterReturn: true,
			rendererMarkerVisibleAfterReturn: true,
			restoreObservation: 'dom',
		})
		assert.deepEqual(evidence.assertions && Object.values(evidence.assertions).every(Boolean), true)
		assert.deepEqual(evidence.cleanup, {
			electronExited: true,
			fakeDaemonClosed: true,
			harnessSocketHoldersTerminated: true,
			tempRootRemoved: true,
		})
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})
