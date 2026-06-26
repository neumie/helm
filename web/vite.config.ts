import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
	plugins: [react()],
	server: {
		port: 7475,
		proxy: {
			'/api': 'http://localhost:7474',
		},
	},
	build: {
		outDir: '../dist/web',
		// Wipe stale hashed bundles each build so the daemon never serves an old
		// index.html → removed-endpoint client.
		emptyOutDir: true,
	},
})
