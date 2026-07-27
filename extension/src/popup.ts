import { DEFAULT_SERVER_URL, getSync, setSync } from './storage'

const urlInput = document.getElementById('url') as HTMLInputElement
const statusEl = document.getElementById('status') as HTMLElement
const AGENT_LABEL: Record<string, string> = { claude: 'Claude', codex: 'Codex', pi: 'Pi' }

// Load saved URL
getSync({ serverUrl: DEFAULT_SERVER_URL })
	.then(items => {
		urlInput.value = items.serverUrl
	})
	.catch(() => {
		urlInput.value = DEFAULT_SERVER_URL
	})

// Save on change (debounced)
let saveTimeout: ReturnType<typeof setTimeout>
urlInput.addEventListener('input', () => {
	clearTimeout(saveTimeout)
	saveTimeout = setTimeout(() => {
		const url = urlInput.value.trim().replace(/\/$/, '')
		void setSync({ serverUrl: url }).then(() => {
			// Test connection
			fetch(`${url}/api/status`)
				.then(r => {
					if (r.ok) {
						statusEl.textContent = 'Connected'
						statusEl.style.color = '#6a9955'
						void loadModelCatalog()
					} else {
						statusEl.textContent = `Error: ${r.status}`
						statusEl.style.color = '#f14c4c'
					}
				})
				.catch(() => {
					statusEl.textContent = 'Cannot connect'
					statusEl.style.color = '#f14c4c'
				})
		})
	}, 500)
})

// --- Favorite models -------------------------------------------------------
// Checkbox list over the daemon's model catalog; checked ids persist to
// `favoriteModels` and become the widget's quick-switch chips.

const modelsSection = document.getElementById('models') as HTMLElement
const modelListEl = document.getElementById('model-list') as HTMLElement

interface CatalogModel {
	id: string
	label: string
}

async function loadModelCatalog(): Promise<void> {
	try {
		const { serverUrl } = await getSync({ serverUrl: DEFAULT_SERVER_URL })
		const res = await fetch(`${serverUrl}/api/config`)
		if (!res.ok) return
		const json = (await res.json()) as {
			data?: { modelCatalog?: Record<string, CatalogModel[]> }
		}
		const catalog = json.data?.modelCatalog
		if (!catalog) return

		const stored = await getSync({ favoriteModels: [] as string[] })
		const favorites = new Set(Array.isArray(stored.favoriteModels) ? stored.favoriteModels : [])

		modelListEl.textContent = ''
		for (const [agent, models] of Object.entries(catalog)) {
			const group = document.createElement('div')
			group.className = 'group'
			group.textContent = AGENT_LABEL[agent] ?? agent
			modelListEl.appendChild(group)
			for (const model of models) {
				const row = document.createElement('label')
				row.className = 'row'
				const box = document.createElement('input')
				box.type = 'checkbox'
				box.checked = favorites.has(model.id)
				box.addEventListener('change', () => {
					if (box.checked) favorites.add(model.id)
					else favorites.delete(model.id)
					void setSync({ favoriteModels: Array.from(favorites) })
				})
				row.appendChild(box)
				row.appendChild(document.createTextNode(` ${model.label} (${model.id})`))
				modelListEl.appendChild(row)
			}
		}
		modelsSection.hidden = false
	} catch {
		// Daemon unreachable — leave the section hidden.
	}
}

void loadModelCatalog()
