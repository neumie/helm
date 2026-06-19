import { createRoot } from 'react-dom/client'
import { App } from './App'
import { SettingsPage } from './pages/SettingsPage'

function Root() {
	const path = window.location.pathname

	if (path === '/settings') {
		return <SettingsPage />
	}

	return <App />
}

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('Root element #root not found')
createRoot(rootEl).render(<Root />)
