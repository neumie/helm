import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { log } from '../util/logger.js'

/**
 * Where the skill bundle gets installed.
 *
 * - `'claude'` → `<root>/.claude/skills/` (Claude Code convention)
 * - `'codex'`  → `<root>/.agents/skills/` (forward-looking — Codex CLI lands here)
 */
export type SkillTarget = 'claude' | 'codex'

/**
 * Resolve the on-disk path of vigil's `vendor/` directory.
 *
 * Constraint (see CLAUDE.md "Worktree cwd"): we must NOT use `process.cwd()`
 * because solver code runs inside per-task git worktrees. Anchor on the module
 * URL instead. Layout:
 *
 *   <repo>/vendor/almanac/<skill>/
 *   <repo>/src/skills/installer.ts        (tsx-dev)
 *   <repo>/dist/skills/installer.js       (compiled)
 *
 * From either, `vendor/` is two levels up.
 */
function vendorRoot(): string {
	const here = dirname(fileURLToPath(import.meta.url))
	return resolve(here, '..', '..', 'vendor')
}

function targetSubdir(target: SkillTarget): string {
	return target === 'claude' ? '.claude/skills' : '.agents/skills'
}

/**
 * Enumerate every skill directory beneath `vendor/`. Each child of
 * `vendor/<bundle>/` is treated as one skill (a `vigil-<name>/` folder).
 *
 * Returns absolute paths.
 */
function listBundledSkillDirs(root: string): string[] {
	if (!existsSync(root)) return []
	const skills: string[] = []
	for (const bundle of readdirSync(root)) {
		const bundlePath = join(root, bundle)
		let bundleStat: ReturnType<typeof statSync>
		try {
			bundleStat = statSync(bundlePath)
		} catch {
			continue
		}
		if (!bundleStat.isDirectory()) continue
		for (const skill of readdirSync(bundlePath)) {
			const skillPath = join(bundlePath, skill)
			let s: ReturnType<typeof statSync>
			try {
				s = statSync(skillPath)
			} catch {
				continue
			}
			if (s.isDirectory()) skills.push(skillPath)
		}
	}
	return skills
}

function copySkillsInto(destDir: string): { copied: number; dest: string } {
	mkdirSync(destDir, { recursive: true })
	const skills = listBundledSkillDirs(vendorRoot())
	let copied = 0
	for (const skillSrc of skills) {
		const skillName = skillSrc.split('/').pop() as string
		const skillDest = join(destDir, skillName)
		// `recursive: true, force: true`: overwrites our own prior installs,
		// preserves any unrelated sibling skills in the destination.
		cpSync(skillSrc, skillDest, { recursive: true, force: true })
		copied++
	}
	return { copied, dest: destDir }
}

/**
 * Install bundled skills into a worktree so the spawned agent can load them.
 *
 * Collision policy: `force: true` overwrites same-name skills (all vendored
 * skills are `vigil-*` prefixed, so this only hits prior vigil installs).
 * Unrelated skills in `.claude/skills/` or `.agents/skills/` are untouched.
 */
export function installSkillsIntoWorktree(worktreePath: string, target: SkillTarget): void {
	const dest = join(worktreePath, targetSubdir(target))
	const { copied } = copySkillsInto(dest)
	log.info('skills', `Installed ${copied} skills into ${dest}`)
}

/**
 * Install bundled skills under the user's home dir for planner-side workflows
 * (i.e. their own Claude Code / Codex sessions, not vigil-spawned ones).
 *
 * Lands under a `vigil/` subdir so we don't clobber the user's own skills:
 *
 *   ~/.claude/skills/vigil/<skill>
 *   ~/.agents/skills/vigil/<skill>
 */
export function installSkillsGlobally(target: SkillTarget): void {
	const base = target === 'claude' ? '.claude/skills/vigil' : '.agents/skills/vigil'
	const dest = join(homedir(), base)
	const { copied } = copySkillsInto(dest)
	log.success('skills', `Installed ${copied} skills into ${dest}`)
}
