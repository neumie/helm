/// <reference path="../open-prototype/vite-env.d.ts" />
// Story/Playwright-only fixtures for the plain code, text and data views. The bytes are served from blob: URLs, which
// stand in for main's helm-viewer://app/file/<token> URLs; everything else is the production DocumentReview window.
// Never import this from production renderer code.
import { textShape } from '../../../../src/document-review/formats'
import type { ReviewViewerFile } from '../../document-review/types'
import { createReviewFixture } from '../document-review/fixtures'
import tsSource from './fixtures/refusal.ts.txt?raw'
import sentryIssue from './fixtures/sentry-issue.json?raw'

export type ViewerFixtureScenario =
	| 'code'
	| 'code-light'
	| 'log'
	| 'json'
	| 'json-light'
	| 'yaml'
	| 'toml'
	| 'jsonl'
	| 'json-error'
	| 'json-large'

const workflow = `name: Deploy
on:
  push:
    branches: [main]
  workflow_dispatch:

concurrency:
  group: deploy-\${{ github.ref }}
  cancel-in-progress: false

defaults: &defaults
  runs-on: ubuntu-latest
  timeout-minutes: 20

jobs:
  test:
    <<: *defaults
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.3.2
      - run: bun install --frozen-lockfile
      - run: bun run check
  deploy:
    <<: *defaults
    needs: test
    environment: production
    steps:
      - uses: actions/checkout@v4
      - run: bun run deploy --env production
        env:
          CLOUDFLARE_ACCOUNT_ID: \${{ vars.CLOUDFLARE_ACCOUNT_ID }}
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
`

const cargo = `[package]
name = "okena-daemon"
version = "0.36.2"
edition = "2024"
rust-version = "1.89"

[dependencies]
tokio = { version = "1.48", features = ["rt-multi-thread", "net", "signal"] }
serde = { version = "1", features = ["derive"] }
tracing = "0.1"

[profile.release]
lto = "thin"
codegen-units = 1

[[bin]]
name = "okena"
path = "src/main.rs"

[package.metadata.limits]
max_sessions = 18446744073709551615
`

const events = [
	'{"at":"2026-11-10T08:14:51Z","level":"info","event":"deploy.started","release":"psyon-api@4.18.2"}',
	'{"at":"2026-11-10T08:15:03Z","level":"info","event":"migration.applied","version":214}',
	'{"at":"2026-11-10T08:15:04Z","level":"warn","event":"pool.slow","waitMs":812}',
	'{"at":"2026-11-10T08:15:09Z","level":"error","event":"request.failed","route":"POST /v2/companies","status":500',
	'{"at":"2026-11-10T08:15:12Z","level":"info","event":"deploy.finished","durationMs":21044}',
].join('\n')

const log = Array.from({ length: 240 }, (_, index) => {
	const second = String(index % 60).padStart(2, '0')
	const minute = String(14 + Math.floor(index / 60)).padStart(2, '0')
	const lines = [
		`2026-11-10 08:${minute}:${second}.214 INFO  [http] POST /v2/companies 201 84ms`,
		`2026-11-10 08:${minute}:${second}.377 DEBUG [db] pool acquire waited 3ms (12/20 busy)`,
		`2026-11-10 08:${minute}:${second}.902 WARN  [ares] lookup 27074358 slow: 1.2s`,
		`2026-11-10 08:${minute}:${second}.950 ERROR [companies] saveFirm failed: TypeError: Cannot read properties of undefined (reading 'ico')`,
	]
	return lines[index % lines.length]
}).join('\n')

function largeJson(): string {
	const companies = Array.from({ length: 12_500 }, (_, index) => ({
		id: 100_000 + index,
		name: `Firma ${index} s.r.o.`,
		ico: String(27_000_000 + index * 7),
		city: ['Praha', 'Brno', 'Ostrava', 'Plzeň', 'Liberec'][index % 5],
		active: index % 11 !== 0,
		contacts: index % 3 === 0 ? [{ email: `info${index}@firma.cz`, phone: null }] : [],
	}))
	return JSON.stringify({ exportedAt: '2026-11-10T08:00:00Z', total: companies.length, companies }, null, 2)
}

const FILES: Record<
	ViewerFixtureScenario,
	{ name: string; path: string; format: 'code' | 'text' | 'data'; language: string; text: () => string }
> = {
	code: {
		name: 'refusal.ts',
		path: '~/code/helm/src/document-review/refusal.ts',
		format: 'code',
		language: 'typescript',
		text: () => tsSource,
	},
	'code-light': {
		name: 'refusal.ts',
		path: '~/code/helm/src/document-review/refusal.ts',
		format: 'code',
		language: 'typescript',
		text: () => tsSource,
	},
	log: {
		name: 'psyon-api.log',
		path: '~/Downloads/psyon-api.log',
		format: 'text',
		language: 'plain',
		text: () => `${log}\n`,
	},
	json: {
		name: 'sentry-issue.json',
		path: '~/Downloads/sentry-issue.json',
		format: 'data',
		language: 'json',
		text: () => sentryIssue,
	},
	'json-light': {
		name: 'sentry-issue.json',
		path: '~/Downloads/sentry-issue.json',
		format: 'data',
		language: 'json',
		text: () => sentryIssue,
	},
	yaml: {
		name: 'deploy.yml',
		path: '~/code/psyon/.github/workflows/deploy.yml',
		format: 'data',
		language: 'yaml',
		text: () => workflow,
	},
	toml: { name: 'Cargo.toml', path: '~/code/okena/Cargo.toml', format: 'data', language: 'toml', text: () => cargo },
	jsonl: {
		name: 'deploy-events.ndjson',
		path: '~/Downloads/deploy-events.ndjson',
		format: 'data',
		language: 'jsonl',
		text: () => `${events}\n`,
	},
	'json-error': {
		name: 'broken.json',
		path: '~/Downloads/broken.json',
		format: 'data',
		language: 'json',
		text: () => '{\n  "id": 1,\n  "name": "missing quote,\n  "ok": true\n}\n',
	},
	'json-large': {
		name: 'companies-export.json',
		path: '~/Downloads/companies-export.json',
		format: 'data',
		language: 'json',
		text: () => largeJson(),
	},
}

/** The production review fixture in plain mode, showing a code/text/data file served from a blob: URL. */
export function createViewerFixture(scenario: ViewerFixtureScenario) {
	const file = FILES[scenario]
	const review = createReviewFixture('plain')
	const urls: string[] = []
	const serve = (text: string): ReviewViewerFile => {
		const bytes = new TextEncoder().encode(text)
		const url = URL.createObjectURL(new Blob([bytes]))
		urls.push(url)
		const shape = textShape(text)
		return {
			url,
			language: file.language,
			size: bytes.length,
			encoding: 'utf-8',
			lines: shape.lines,
			ending: shape.ending,
		}
	}
	let revision = 1
	const theme = scenario.endsWith('-light') ? ('light' as const) : undefined
	const show = (text: string) =>
		review.replaceDocument(
			{
				name: file.name,
				relativePath: file.path,
				format: file.format,
				text: '',
				previous: null,
				revision: String(revision++).padStart(64, '0'),
				viewer: serve(text),
			},
			theme,
		)
	let current = file.text()
	show(current)
	return {
		...review,
		/** Stands in for a live reload: the file changed on disk and main issued a new token. */
		update: (text: string) => {
			current = text
			show(text)
		},
		/** A growing log: the same text plus more lines at the end. */
		append: (more: string) => {
			current += more
			show(current)
		},
		dispose: () => {
			review.dispose()
			for (const url of urls) URL.revokeObjectURL(url)
		},
	}
}
