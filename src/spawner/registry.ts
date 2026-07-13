import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { HelmConfig } from '../config.js'
import { createDefaultSpawner } from './default-spawner.js'
import { spawnerNameSchema } from './name.js'
import type { SpawnerName } from './name.js'
import type { Spawner } from './spawner.js'

const SPAWNER_MODULE_FILES = ['spawner.js', 'spawner.ts', 'spawner.mjs']

export { spawnerNameSchema }
export type { SpawnerName }

export interface SpawnerAdapterInfo {
	name: SpawnerName
	available: boolean
}

interface SpawnerRegistryOptions {
	extensionDirUrl?: URL
}

interface SpawnerAdapterSpec {
	name: SpawnerName
	moduleUrl: URL
	create(config: HelmConfig): Promise<Spawner> | Spawner
}

interface SpawnerModule {
	createSpawner?: unknown
}

export interface SpawnerRegistry {
	listAdapters(): SpawnerAdapterInfo[]
	create(config: HelmConfig, name?: SpawnerName): Promise<Spawner>
}

function moduleExists(path: string): boolean {
	const url = new URL(path, import.meta.url)
	return existsSync(fileURLToPath(url))
}

function defaultAdapterInstalled(): boolean {
	return moduleExists('./default-spawner.js') || moduleExists('./default-spawner.ts')
}

function firstSpawnerModuleUrl(dirPath: string): URL | null {
	for (const file of SPAWNER_MODULE_FILES) {
		const candidate = join(dirPath, file)
		if (existsSync(candidate)) return pathToFileURL(candidate)
	}
	return null
}

function discoverExtensionSpecs(extensionDirUrl: URL): SpawnerAdapterSpec[] {
	const extensionDir = fileURLToPath(extensionDirUrl)
	if (!existsSync(extensionDir)) return []

	const specs: SpawnerAdapterSpec[] = []
	for (const entry of readdirSync(extensionDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue
		const name = spawnerNameSchema.safeParse(entry.name)
		if (!name.success) continue
		const moduleUrl = firstSpawnerModuleUrl(join(extensionDir, entry.name))
		if (!moduleUrl) continue
		specs.push({
			name: name.data,
			moduleUrl,
			create: (config: HelmConfig) => createSpawnerFromModule(name.data, moduleUrl, config),
		})
	}
	return specs
}

function discoverSpecs(extensionDirUrl: URL): SpawnerAdapterSpec[] {
	const specs: SpawnerAdapterSpec[] = []
	if (defaultAdapterInstalled()) {
		specs.push({
			name: 'default',
			moduleUrl: new URL('./default-spawner.js', import.meta.url),
			create: createDefaultSpawner,
		})
	}

	for (const spec of discoverExtensionSpecs(extensionDirUrl)) {
		if (specs.some(existing => existing.name === spec.name)) continue
		specs.push(spec)
	}

	return specs.sort((a, b) => {
		if (a.name === 'default') return -1
		if (b.name === 'default') return 1
		return a.name.localeCompare(b.name)
	})
}

function spawnerFactory(
	adapterName: SpawnerName,
	module: SpawnerModule,
): (config: HelmConfig) => Spawner | Promise<Spawner> {
	if (typeof module.createSpawner !== 'function') {
		throw new Error(`Spawner adapter ${adapterName} must export createSpawner(config)`)
	}
	return module.createSpawner as (config: HelmConfig) => Spawner | Promise<Spawner>
}

function assertSpawner(adapterName: SpawnerName, value: unknown): asserts value is Spawner {
	if (
		typeof value !== 'object' ||
		value === null ||
		typeof (value as Spawner).name !== 'string' ||
		typeof (value as Spawner).startPlanningSession !== 'function'
	) {
		throw new Error(`Spawner adapter ${adapterName} did not return a Spawner`)
	}
}

async function createSpawnerFromModule(adapterName: SpawnerName, moduleUrl: URL, config: HelmConfig): Promise<Spawner> {
	const module = (await import(moduleUrl.href)) as SpawnerModule
	const spawner = await spawnerFactory(adapterName, module)(config)
	assertSpawner(adapterName, spawner)
	return spawner
}

export function createSpawnerRegistry(options: SpawnerRegistryOptions = {}): SpawnerRegistry {
	const extensionDirUrl = options.extensionDirUrl ?? new URL('../extensions/', import.meta.url)
	return {
		listAdapters() {
			return discoverSpecs(extensionDirUrl).map(spec => ({
				name: spec.name,
				available: true,
			}))
		},
		async create(config, name = config.spawner.name) {
			const parsed = spawnerNameSchema.safeParse(name)
			if (!parsed.success) throw new Error(`Invalid Spawner adapter name: ${name}`)
			const spec = discoverSpecs(extensionDirUrl).find(adapter => adapter.name === parsed.data)
			if (!spec) throw new Error(`Spawner adapter not installed: ${parsed.data}`)
			return spec.create(config)
		},
	}
}

const registry = createSpawnerRegistry()

export function listSpawnerAdapters(): SpawnerAdapterInfo[] {
	return registry.listAdapters()
}

export async function createSpawner(config: HelmConfig, name: SpawnerName = config.spawner.name): Promise<Spawner> {
	return registry.create(config, name)
}
