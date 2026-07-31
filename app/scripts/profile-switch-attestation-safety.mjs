import { execFile } from 'node:child_process'

/**
 * Return existing Helm/development Electron process ids from
 * `ps -axo pid=,command=` output. False positives are intentional: a release
 * canary is optional and must never co-exist with an operator desktop, even
 * when that desktop came from another checkout.
 */
export function findConflictingHelmDesktopPids(processList, options) {
	const { electronLauncher, electronExecutable, appRoot, currentPid } = options
	const electronHelperAppPath = `--app-path=${appRoot}`
	const anyDevElectronLauncher = /(?:^|\s)\S*node_modules\/\.bin\/electron(?:\s|$)/
	const anyDevElectronMain = /(?:^|\s)\S*node_modules\/electron\/dist\/Electron\.app\/Contents\/MacOS\/Electron(?:\s|$)/
	const anyElectronAppHelper = /Electron Helper.*--app-path=/
	const packagedHelm = /(?:^|\s)\S*Helm\.app\/Contents\/MacOS\/\S+(?:\s|$)/i
	const pids = []
	for (const line of processList.split('\n')) {
		const match = /^\s*(\d+)\s+(.+)$/.exec(line)
		if (!match) continue
		const pid = Number(match[1])
		if (!Number.isSafeInteger(pid) || pid <= 0 || pid === currentPid) continue
		const command = match[2]
		if (
			command.includes(electronLauncher) ||
			command.includes(electronExecutable) ||
			command.includes(electronHelperAppPath) ||
			anyDevElectronLauncher.test(command) ||
			anyDevElectronMain.test(command) ||
			anyElectronAppHelper.test(command) ||
			packagedHelm.test(command)
		) {
			pids.push(pid)
		}
	}
	return [...new Set(pids)].sort((left, right) => left - right)
}

export function isAttestedDtachCommand(command, socketPath, dtachPath) {
	const words = command.trim().split(/\s+/)
	return (
		words.length >= 3 &&
		words[0] === dtachPath &&
		(words[1] === '-A' || words[1] === '-n' || words[1] === '-a') &&
		words[2] === socketPath
	)
}

export function processGroupPidsFromList(processList, processGroupId) {
	const pids = []
	for (const line of processList.split('\n')) {
		const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
		if (!match || Number(match[2]) !== processGroupId) continue
		pids.push(Number(match[1]))
	}
	return pids
}

function readProcessGroups() {
	return new Promise((resolve, reject) => {
		execFile('ps', ['-axo', 'pid=,pgid='], { timeout: 5_000 }, (error, stdout) => {
			if (error) reject(error)
			else resolve(stdout)
		})
	})
}

async function waitForProcessGroupEmpty(processGroupId, timeoutMs) {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		const processList = await readProcessGroups()
		if (processGroupPidsFromList(processList, processGroupId).length === 0) return true
		await new Promise(resolve => setTimeout(resolve, 50))
	}
	return processGroupPidsFromList(await readProcessGroups(), processGroupId).length === 0
}

function signalProcessGroup(processGroupId, signal) {
	try {
		process.kill(-processGroupId, signal)
	} catch (error) {
		if (error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH') return
		throw error
	}
}

const processGroupTerminations = new Map()

/**
 * Terminate and prove quiescence of one detached, caller-owned process group.
 * The first caller owns cleanup permanently; timeout and outer-finally paths
 * receive the exact same Promise and can never signal a reused PGID twice.
 */
export function terminateOwnedProcessGroup(processGroupId, options = {}) {
	if (!Number.isSafeInteger(processGroupId) || processGroupId <= 0) {
		return Promise.reject(new Error('Invalid owned process group id'))
	}
	const existing = processGroupTerminations.get(processGroupId)
	if (existing) return existing
	const operation = (async () => {
		const initialProcessList = await readProcessGroups()
		if (processGroupPidsFromList(initialProcessList, processGroupId).length === 0) return
		const termTimeoutMs = options.termTimeoutMs ?? 500
		const killTimeoutMs = options.killTimeoutMs ?? 2_000
		signalProcessGroup(processGroupId, 'SIGTERM')
		if (await waitForProcessGroupEmpty(processGroupId, termTimeoutMs)) return
		signalProcessGroup(processGroupId, 'SIGKILL')
		if (!(await waitForProcessGroupEmpty(processGroupId, killTimeoutMs))) {
			throw new Error(`Timed out waiting for owned process group ${processGroupId} to become empty`)
		}
	})()
	processGroupTerminations.set(processGroupId, operation)
	return operation
}
