// Story-only `helm open` prototype: the structured-data format view (JSON / JSONL / YAML / TOML).
import type { Meta, StoryObj } from '@storybook/react-vite'
import { useState } from 'react'
import { FormatStage } from './FormatStage'
import { JsonView, JsonViewer } from './JsonView'
import { FIXTURES } from './fixtures'
import type { FeedbackAnchor, FeedbackHost, RendererProps, ViewerFile } from './types'

const meta: Meta = {
	title: 'Views/Helm open/C Format views/JSON',
	parameters: { layout: 'fullscreen' },
}

export default meta
type Story = StoryObj

const FRAMES = '$.latestEvent.exception.values[0].stacktrace.frames'

function textFile(name: string, path: string, mime: string, language: string, text: string): ViewerFile {
	return {
		name,
		path,
		format: 'json',
		size: new TextEncoder().encode(text).length,
		modified: 'Today 11:02',
		url: `data:${mime};charset=utf-8,${encodeURIComponent(text)}`,
		language,
	}
}

const CI_YAML = `# Runs on every push and pull request to main.
name: ci

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

concurrency:
  group: ci-\${{ github.ref }}
  cancel-in-progress: true

env:
  NODE_VERSION: 22
  DATABASE_URL: postgres://postgres:postgres@localhost:5432/psyon_test

jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_PASSWORD: postgres
        ports:
          - 5432:5432
        options: >-
          --health-cmd pg_isready
          --health-interval 5s
          --health-retries 10
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: \${{ env.NODE_VERSION }}
          cache: npm
      - name: Install
        run: npm ci
      - name: Migrate
        run: npm run db:migrate
      - name: Test
        run: |
          npm run lint
          npm test -- --reporter=dot
      - name: Upload coverage
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: coverage
          path: coverage/
          retention-days: 7
`

const YAML_FILE = textFile('ci.yml', '~/code/psyon/api/.github/workflows/ci.yml', 'text/yaml', 'YAML', CI_YAML)

const AUDIT_JSONL = [
	'{"at":"2026-11-09T07:40:40Z","level":"info","msg":"lookup company","ico":"27074358"}',
	'{"at":"2026-11-09T07:40:43Z","level":"info","msg":"ares response","status":200,"ms":412}',
	'{"at":"2026-11-09T07:40:44Z","level":"warn","msg":"ares record without sidlo","fields":["obchodniJmeno","ico"]}',
	'',
	'{"at":"2026-11-09T07:41:03Z","level":"error","msg":"saveFirm failed","error":{"type":"TypeError","message":"Cannot read properties of undefined (reading \'ico\')"},"retry":false}',
	'{"at":"2026-11-09T07:41:03Z","level":"info","msg":"request done","status":500,"ms":1288,"user":null}',
	'{"at":"2026-11-09T07:41:09Z","level":"info","msg":"lookup company","ico":"0',
].join('\n')

const JSONL_FILE = textFile(
	'company-create.jsonl',
	'~/code/psyon/api/tmp/company-create.jsonl',
	'application/jsonl',
	'JSONL',
	AUDIT_JSONL,
)

const PYPROJECT_TOML = `[project]
name = "psyon-ares"
version = "0.4.1"
requires-python = ">=3.12"
dependencies = ["httpx>=0.27", "pydantic>=2.8"]

[tool.ruff]
line-length = 110
target-version = "py312"

# Lookups older than this are refetched.
[cache]
ttl_hours = 24
enabled = true
refreshed = 2026-11-09T07:40:00Z

[[endpoints]]
name = "ekonomicke-subjekty"
url = "https://ares.gov.cz/ekonomicke-subjekty-v-be/rest"
timeout = 5.0
`

const TOML_FILE = textFile(
	'pyproject.toml',
	'~/code/psyon/ares/pyproject.toml',
	'application/toml',
	'TOML',
	PYPROJECT_TOML,
)

// Story knobs ride on JsonViewer; the registry entry stays the plain RendererProps JsonView.
function TreeAtFrames(props: RendererProps) {
	return <JsonViewer {...props} initialPath={`${FRAMES}[2]`} initialExpand={[FRAMES, `${FRAMES}[2]`]} />
}

function RawMode(props: RendererProps) {
	return <JsonViewer {...props} initialMode="raw" />
}

export const Tree: Story = {
	render: () => <FormatStage file={FIXTURES.json} Renderer={TreeAtFrames} />,
}

export const Raw: Story = {
	render: () => <FormatStage file={FIXTURES.json} Renderer={RawMode} />,
}

function FeedbackStage() {
	const [active, setActive] = useState<FeedbackAnchor | null>({
		kind: 'json-path',
		path: '$.latestEvent.exception.values[0].value',
		preview: '"Cannot read properties of undefined (reading \'ico\')"',
	})
	const feedback: FeedbackHost = { active, onAnchor: anchor => setActive(anchor) }
	return <FormatStage file={FIXTURES.json} Renderer={JsonView} feedback={feedback} />
}

export const FeedbackMode: Story = {
	render: () => <FeedbackStage />,
}

export const Yaml: Story = {
	render: () => <FormatStage file={YAML_FILE} Renderer={JsonView} />,
}

export const YamlRaw: Story = {
	render: () => <FormatStage file={YAML_FILE} Renderer={RawMode} />,
}

export const JsonLines: Story = {
	render: () => <FormatStage file={JSONL_FILE} Renderer={JsonView} />,
}

export const Toml: Story = {
	render: () => <FormatStage file={TOML_FILE} Renderer={JsonView} />,
}

export const TomlRaw: Story = {
	render: () => <FormatStage file={TOML_FILE} Renderer={RawMode} />,
}
