import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
	testDir: './browser-tests',
	fullyParallel: false,
	use: {
		baseURL: 'http://127.0.0.1:6010',
		browserName: 'chromium',
		trace: 'retain-on-failure',
	},
	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
	webServer: {
		command: 'bunx storybook dev --ci -p 6010',
		url: 'http://127.0.0.1:6010',
		reuseExistingServer: !process.env.CI,
		timeout: 120_000,
	},
})
