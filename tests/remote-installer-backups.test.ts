import assert from 'node:assert/strict'
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	readlinkSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { prepareRemotePiInstall } from '../src/remote/installer.js'

test('operator installation keeps private backups outside a configuration repository and preserves guarded rollback', () => {
	const root = realpathSync(mkdtempSync('/tmp/hr-install-backup-'))
	const repository = join(root, 'configuration-repository')
	const backups = join(root, 'private-backups')
	mkdirSync(repository, { mode: 0o700 })
	mkdirSync(backups, { mode: 0o700 })
	const target = join(repository, 'settings.json')
	const pointer = join(root, 'settings.json')
	const original = '{"packages":["npm:@juicesharp/rpiv-ask-user-question","npm:unrelated"],"model":"preserve-model"}\n'
	writeFileSync(target, original, { mode: 0o600 })
	symlinkSync(target, pointer)
	const plan = {
		settingsPath: pointer,
		bridgeSource: '/fixture/helm-remote-bridge',
		questionForkSource: '/fixture/helm-ask-user-question',
		backupDirectory: backups,
	}
	try {
		const install = prepareRemotePiInstall(plan)
		assert.equal(dirname(install.backupPath), backups)
		assert.deepEqual(readdirSync(repository), ['settings.json'], 'no private sidecar appears inside the repository')
		assert.equal(statSync(install.backupPath).mode & 0o777, 0o600)
		assert.equal(readFileSync(install.backupPath, 'utf8'), original)
		install.apply()
		assert.equal(readlinkSync(pointer), target)
		assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')), {
			packages: [
				'npm:unrelated',
				{ source: plan.questionForkSource, extensions: ['index.ts'] },
				{ source: plan.bridgeSource, extensions: ['index.ts'] },
			],
			model: 'preserve-model',
		})
		install.rollback()
		assert.equal(readFileSync(target, 'utf8'), original)
		assert.equal(readlinkSync(pointer), target)

		const linked = join(root, 'linked-backups')
		symlinkSync(backups, linked)
		assert.throws(() => prepareRemotePiInstall({ ...plan, backupDirectory: linked }), /backup directory/i)
		chmodSync(backups, 0o755)
		assert.throws(() => prepareRemotePiInstall(plan), /backup directory/i)
		assert.throws(() => prepareRemotePiInstall({ ...plan, backupDirectory: target }), /backup directory/i)
		assert.equal(readFileSync(target, 'utf8'), original, 'rejected backup locations never change settings')
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})
