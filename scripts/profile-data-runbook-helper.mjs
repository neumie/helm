#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function fail(message) {
	throw new Error(`Profile data runbook: ${message}`)
}

function usage() {
	console.error(
		'Usage: node scripts/profile-data-runbook-helper.mjs assert-stopped-database <dataset-root> | compare-manifests <expected.json> <actual.json>',
	)
}

function readManifest(path) {
	try {
		const value = JSON.parse(readFileSync(path, 'utf8'))
		if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${path} is not a manifest object`)
		return value
	} catch (error) {
		if (error instanceof Error && error.message.startsWith('Profile data runbook:')) throw error
		fail(`could not read manifest ${path}: ${error instanceof Error ? error.message : String(error)}`)
	}
}

function canonicalJson(value) {
	return JSON.stringify(value)
}

function compareManifests(expectedPath, actualPath) {
	const expected = readManifest(expectedPath)
	const actual = readManifest(actualPath)
	if (canonicalJson(expected.logical) !== canonicalJson(actual.logical)) fail('logical manifest sections differ')
	if (canonicalJson(expected.files) !== canonicalJson(actual.files)) fail('file hash manifest sections differ')
}

function assertStoppedDatabase(rootInput) {
	const root = resolve(rootInput)
	const paths = ['helm.db', 'helm.db-wal', 'helm.db-shm']
		.map(name => ({ name, path: resolve(root, name) }))
		.filter(({ path }) => existsSync(path))
	if (!paths.some(({ name }) => name === 'helm.db')) fail('helm.db is missing')
	for (const { name, path } of paths) {
		if (!lstatSync(path).isFile()) fail(`${name} must be a regular file before lsof inspection`)
	}

	const lsof = spawnSync('lsof', ['-t', ...paths.map(({ path }) => path)], { encoding: 'utf8' })
	if (lsof.error) fail(`could not execute lsof: ${lsof.error.message}`)
	if (lsof.stderr) fail(`lsof wrote diagnostics: ${lsof.stderr.trim()}`)
	if (lsof.status === 0) fail(`database is still open by process(es): ${lsof.stdout.trim() || 'unknown'}`)
	if (lsof.status !== 1) fail(`lsof exited with status ${lsof.status ?? 'unknown'}`)
	if (lsof.stdout.trim()) fail(`lsof reported unexpected output: ${lsof.stdout.trim()}`)
}

try {
	const [command, ...args] = process.argv.slice(2)
	if (command === 'assert-stopped-database' && args.length === 1) {
		assertStoppedDatabase(args[0])
	} else if (command === 'compare-manifests' && args.length === 2) {
		compareManifests(args[0], args[1])
	} else {
		usage()
		process.exitCode = 64
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error))
	process.exitCode = 1
}
