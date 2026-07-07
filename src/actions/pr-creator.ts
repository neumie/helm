import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { log } from '../util/logger.js'

const execFileAsync = promisify(execFile)

interface PROptions {
	worktreePath: string
	branchName: string
	baseBranch: string
	title: string
	body: string
	draft: boolean
}

export async function createPR(opts: PROptions): Promise<string> {
	const args = [
		'pr',
		'create',
		'--base',
		opts.baseBranch,
		'--head',
		opts.branchName,
		'--title',
		opts.title,
		'--body',
		opts.body,
	]
	if (opts.draft) args.push('--draft')

	const { stdout } = await execFileAsync('gh', args, { cwd: opts.worktreePath })
	const result = stdout.trim()

	log.success('pr-creator', `Created PR: ${result}`)
	return result
}
