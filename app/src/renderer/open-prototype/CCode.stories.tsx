import type { Meta, StoryObj } from '@storybook/react-vite'
import { useEffect, useRef, useState } from 'react'
import { CodeView, searchInView } from './CodeView'
import { FormatStage } from './FormatStage'
import { FIXTURES } from './fixtures'
import refusalSource from './fixtures/refusal.ts?raw'
import type { FeedbackAnchor, FeedbackHost, ViewerFile } from './types'

/**
 * `helm open` code + plain text view: CodeMirror 6, read only but focusable, so arrows,
 * Shift+arrows, ⌘A, copy and ⌘F search work. Syntax color is glyph color from the ANSI tokens.
 * In agent feedback mode a finished selection becomes a `lines` anchor.
 */
const meta: Meta = {
	title: 'Views/Helm open/C Format views/Code',
	parameters: { layout: 'fullscreen' },
}
export default meta
type Story = StoryObj

// FIXTURES.ts already carries the untouched bytes (`?raw`); Vite would transpile a fetched *.ts path.
const TS_FILE: ViewerFile = FIXTURES.ts

export const Default: Story = {
	render: () => <FormatStage file={TS_FILE} Renderer={CodeView} />,
}

function SearchStory() {
	const root = useRef<HTMLDivElement>(null)
	useEffect(() => {
		const element = root.current
		if (!element) return
		if (searchInView(element, 'refuse')) return
		const observer = new MutationObserver(() => {
			if (searchInView(element, 'refuse')) observer.disconnect()
		})
		observer.observe(element, { childList: true, subtree: true })
		return () => observer.disconnect()
	}, [])
	return (
		<div ref={root} style={{ display: 'contents' }}>
			<FormatStage file={TS_FILE} Renderer={CodeView} />
		</div>
	)
}

/** ⌘F panel open with "refuse" highlighted and its first match current. */
export const Search: Story = { render: () => <SearchStory /> }

// A realistic, deterministic Laravel-ish API server log (~300 lines, some long lines).
function serverLog(): string {
	let seed = 20261109
	const random = () => {
		seed = (seed * 1103515245 + 12345) % 2147483648
		return seed / 2147483648
	}
	const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T
	const routes = [
		'GET /api/companies',
		'GET /api/companies/4182',
		'POST /api/companies',
		'PATCH /api/companies/4182',
		'GET /api/invoices?status=open&page=2',
		'POST /api/invoices/9921/send',
		'GET /api/users/me',
		'POST /api/auth/refresh',
		'GET /health',
	]
	const lines: string[] = []
	let time = Date.UTC(2026, 10, 9, 8, 55, 0)
	for (let n = 0; n < 300; n++) {
		time += Math.floor(random() * 2400)
		const stamp = new Date(time).toISOString().replace('T', ' ').replace('Z', '')
		const request = `req_${Math.floor(random() * 0xffffff)
			.toString(16)
			.padStart(6, '0')}`
		const roll = random()
		if (n % 47 === 31) {
			lines.push(
				`[${stamp}] production.ERROR: SQLSTATE[23505]: Unique violation: 7 ERROR:  duplicate key value violates unique constraint "companies_ico_unique" DETAIL:  Key (ico)=(27082440) already exists. (SQL: insert into "companies" ("name", "ico", "dic", "created_at", "updated_at") values (Psyon s.r.o., 27082440, CZ27082440, 2026-11-09 ${stamp.slice(11, 19)}, 2026-11-09 ${stamp.slice(11, 19)})) {"request":"${request}","user":118}`,
			)
			lines.push(
				'#0 /var/www/api/vendor/laravel/framework/src/Illuminate/Database/Connection.php(760): PDOStatement->execute()',
			)
			lines.push(
				'#1 /var/www/api/app/Http/Controllers/CompanyController.php(54): App\\Actions\\CreateCompany->handle()',
			)
			lines.push('#2 {main}')
			continue
		}
		if (roll < 0.08) {
			lines.push(
				`[${stamp}] production.WARNING: Slow query (${(800 + Math.floor(random() * 2200)).toLocaleString('en-US')} ms) {"request":"${request}","sql":"select * from invoices where status = ? order by issued_at desc limit 50 offset 50"}`,
			)
			continue
		}
		if (roll < 0.12) {
			lines.push(
				`[${stamp}] production.NOTICE: Queue worker processed SendInvoiceMail {"job":"${request}","attempt":1}`,
			)
			continue
		}
		const route = pick(routes)
		const status =
			route.startsWith('POST /api/companies') && random() < 0.4
				? 422
				: route === 'GET /health'
					? 200
					: pick([200, 200, 200, 201, 204, 304])
		const ms = Math.floor(4 + random() * (route === 'GET /health' ? 6 : 180))
		lines.push(
			`[${stamp}] production.INFO: ${route} ${status} ${ms}ms {"request":"${request}","ip":"10.0.4.${Math.floor(random() * 250)}"}`,
		)
	}
	return `${lines.slice(0, 300).join('\n')}\n`
}

const LOG = serverLog()
const PLAIN_TEXT: ViewerFile = {
	name: 'server.log',
	path: '~/code/psyon/api/storage/logs/server.log',
	format: 'code',
	size: new TextEncoder().encode(LOG).byteLength,
	modified: 'Today 10:24',
	url: `data:text/plain;charset=utf-8,${encodeURIComponent(LOG)}`,
	language: 'Plain text',
}

/** An unknown extension stays plain text: no highlighting, long lines scroll inside the editor. */
export const PlainText: Story = {
	render: () => <FormatStage file={PLAIN_TEXT} Renderer={CodeView} />,
}

const QUOTE_12_18 = refusalSource.split('\n').slice(11, 18).join('\n')

function FeedbackStory() {
	const [active, setActive] = useState<FeedbackAnchor | null>({
		kind: 'lines',
		startLine: 12,
		endLine: 18,
		quote: QUOTE_12_18,
	})
	const feedback: FeedbackHost = { active, onAnchor: anchor => setActive(anchor) }
	return <FormatStage file={TS_FILE} Renderer={CodeView} feedback={feedback} />
}

/** Agent feedback mode: lines 12–18 are being written about; select other lines to move it. */
export const FeedbackMode: Story = { render: () => <FeedbackStory /> }
