const urlInput = document.getElementById('url') as HTMLInputElement
const statusEl = document.getElementById('status') as HTMLElement

// Load saved URL
chrome.storage.sync.get({ serverUrl: 'http://localhost:7474' }, items => {
	urlInput.value = items.serverUrl
})

// Save on change (debounced)
let saveTimeout: ReturnType<typeof setTimeout>
urlInput.addEventListener('input', () => {
	clearTimeout(saveTimeout)
	saveTimeout = setTimeout(() => {
		const url = urlInput.value.trim().replace(/\/$/, '')
		chrome.storage.sync.set({ serverUrl: url }, () => {
			// Test connection
			fetch(`${url}/api/status`)
				.then(r => {
					if (r.ok) {
						statusEl.textContent = 'Connected'
						statusEl.style.color = '#6a9955'
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
