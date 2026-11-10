// CSV/TSV files for Storybook, Playwright and the node tests, built at run time from a fixed seed: an invoicing
// export, a Czech Excel export (semicolons, BOM, decimal commas), a Sentry TSV, a 500-column sensor sheet, a
// million-row event log, support tickets with quoted line breaks, and the files Helm refuses. All fictional.

/** A small seeded generator, so every build of a fixture is the same file. */
function random(seed: number) {
	let state = seed >>> 0
	return () => {
		state = (state + 0x6d2b79f5) >>> 0
		let value = state
		value = Math.imul(value ^ (value >>> 15), value | 1)
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
		return ((value ^ (value >>> 14)) >>> 0) / 4294967296
	}
}
const pick = <T>(next: () => number, values: readonly T[]): T => values[Math.floor(next() * values.length)] as T
const pad = (value: number, size = 2) => String(value).padStart(size, '0')
const quote = (value: string) => (/[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value)

const CLIENTS = [
	'Psyon s.r.o.',
	'Nordic Freight AB',
	'Kavárna Lípa',
	'Dentium Clinic',
	'Northwind Analytics s.r.o.',
	'Atelier Mráz',
	'Brno Bike Works',
	'Lumen Studio, z.s.',
	'Horák & Partneři',
	'Vinařství U Kostela',
]
const NOTES = [
	'',
	'',
	'',
	'Paid by card',
	'Reminder sent 2026-10-18',
	'Split payment, see "Agreement 14"',
	'Discount 5 %, approved by Jana',
	'Client asks for a copy\nto the accounts address',
	'Disputed: wrong VAT rate, credit note pending',
]

/** `clientcare-invoices-2026-10.csv`: a header and `rows` invoices, comma-separated, LF. */
export function buildInvoiceExport(rows = 1800, seed = 7): string {
	const next = random(seed)
	const lines = ['Invoice,Client,Issued,Due,Amount (CZK),VAT,Status,Note']
	for (let index = 0; index < rows; index++) {
		const day = 1 + (index % 28)
		const amount = Math.round(1200 + next() * 98_000) + Math.round(next() * 100) / 100
		const status = pick(next, ['Paid', 'Paid', 'Paid', 'Sent', 'Overdue', 'Draft'])
		lines.push(
			[
				`2026-${pad(index + 1, 4)}`,
				quote(pick(next, CLIENTS)),
				`2026-10-${pad(day)}`,
				`2026-11-${pad(day)}`,
				amount.toFixed(2),
				pick(next, ['21', '21', '12', '0']),
				status,
				quote(pick(next, NOTES)),
			].join(','),
		)
	}
	return `${lines.join('\n')}\n`
}

/** `faktury-2026-10.csv`: what Czech Excel writes: UTF-8 BOM, semicolons, decimal commas, CRLF. */
export function buildCzechExport(rows = 240, seed = 11): string {
	const next = random(seed)
	const lines = ['Číslo faktury;Odběratel;Datum vystavení;Částka bez DPH;DPH;Měna;Poznámka']
	for (let index = 0; index < rows; index++) {
		const amount = (Math.round((800 + next() * 60_000) * 100) / 100).toFixed(2).replace('.', ',')
		lines.push(
			[
				`FV-2026-${pad(index + 1, 4)}`,
				pick(next, CLIENTS),
				`${1 + (index % 28)}. 10. 2026`,
				amount,
				pick(next, ['21 %', '12 %', '0 %']),
				pick(next, ['CZK', 'CZK', 'CZK', 'EUR']),
				pick(next, ['', '', 'Uhrazeno převodem', 'Záloha 50 %', 'Upomínka odeslána']),
			].join(';'),
		)
	}
	return `﻿${lines.join('\r\n')}\r\n`
}

/** `sentry-events-2026-11-09.tsv`: tab-separated events. */
export function buildSentryTsv(rows = 600, seed = 3): string {
	const next = random(seed)
	const lines = ['timestamp\tlevel\tissue\tmessage\turl\tuser']
	const issues = [
		['CLIENTCARE-4F2', 'TypeError: Cannot read properties of undefined (reading "ico")'],
		['CLIENTCARE-4F7', 'FormError: Company registration number is required'],
		['CLIENTCARE-51A', 'NetworkError: Failed to fetch /api/contember'],
		['HELM-1C', 'ViewerSourceChanged: changed'],
	] as const
	for (let index = 0; index < rows; index++) {
		const [issue, message] = pick(next, issues)
		lines.push(
			[
				`2026-11-09T${pad(8 + Math.floor(index / 60))}:${pad(index % 60)}:${pad(Math.floor(next() * 60))}Z`,
				pick(next, ['error', 'error', 'warning', 'fatal']),
				issue,
				message,
				pick(next, ['https://app.example.invalid/companies/new', 'https://app.example.invalid/invoices/2026-118']),
				`user-${Math.floor(next() * 900 + 100)}`,
			].join('\t'),
		)
	}
	return `${lines.join('\n')}\n`
}

/** `sensor-readings-wide.csv`: a timestamp and 499 sensors, `rows` readings. */
export function buildWideSheet(columns = 500, rows = 120, seed = 5): string {
	const next = random(seed)
	const header = ['timestamp']
	for (let column = 1; column < columns; column++) header.push(`sensor_${pad(column, 3)}`)
	const lines = [header.join(',')]
	for (let row = 0; row < rows; row++) {
		const values = [`2026-11-09 ${pad(Math.floor(row / 6))}:${pad((row % 6) * 10)}`]
		for (let column = 1; column < columns; column++) values.push((18 + next() * 9).toFixed(2))
		lines.push(values.join(','))
	}
	return `${lines.join('\n')}\n`
}

/**
 * `events-2026.csv`: a header and `rows - 1` events, `rows` records in all; returned in parts (one per 10 000
 * records) so a page can make a Blob of ~55 MB without one giant string.
 */
export function buildEventLog(rows = 1_000_000, seed = 13): string[] {
	const next = random(seed)
	const parts: string[] = ['id,timestamp,user,event,duration_ms,status\n']
	const events = ['login', 'invoice.create', 'invoice.send', 'company.update', 'export.csv', 'logout']
	let lines: string[] = []
	for (let index = 1; index < rows; index++) {
		const second = index % 86_400
		lines.push(
			`${index},2026-03-${pad(1 + (Math.floor(index / 86_400) % 28))}T${pad(Math.floor(second / 3600))}:${pad(Math.floor(second / 60) % 60)}:${pad(second % 60)}Z,user-${(index * 7919) % 5000},${events[index % events.length]},${Math.floor(next() * 2400)},${index % 97 === 0 ? 'error' : 'ok'}\n`,
		)
		if (lines.length === 10_000) {
			parts.push(lines.join(''))
			lines = []
		}
	}
	if (lines.length) parts.push(lines.join(''))
	return parts
}

/** `numbers.csv`: `rows` one-value records, for the row limit. */
export function buildNumbers(rows: number): string[] {
	const parts: string[] = []
	let lines: string[] = []
	for (let index = 0; index < rows; index++) {
		lines.push(`${index}\n`)
		if (lines.length === 100_000) {
			parts.push(lines.join(''))
			lines = []
		}
	}
	if (lines.length) parts.push(lines.join(''))
	return parts
}

/** `support-tickets.csv`: messages with quoted line breaks (LF and CRLF), quotes and delimiters inside values. */
export function buildSupportTickets(): string {
	const rows = [
		['Ticket', 'Opened', 'Client', 'Subject', 'Message', 'Priority'],
		[
			'T-1041',
			'2026-11-02',
			'Psyon s.r.o.',
			'Company form does not save',
			'Hi,\nthe "Create company" form forgets the IČO after Save.\nTried twice, same result.\n\nThanks, Petra',
			'High',
		],
		[
			'T-1042',
			'2026-11-02',
			'Kavárna Lípa',
			'Invoice PDF, wrong address',
			'Street should be "Lipová 12, Brno".',
			'Normal',
		],
		[
			'T-1043',
			'2026-11-03',
			'Nordic Freight AB',
			'Export to CSV',
			'Could the export use semicolons; our Excel is Czech.\r\nRegards,\r\nMagnus',
			'Low',
		],
		[
			'T-1044',
			'2026-11-04',
			'Dentium Clinic',
			'Login loop',
			'After the update the login page reloads forever.',
			'High',
		],
		[
			'T-1045',
			'2026-11-05',
			'Lumen Studio, z.s.',
			'VAT 12 %',
			'Line 3 says "21 %" but we agreed 12 %, see the attached contract (page 2).',
			'Normal',
		],
	]
	return `${rows.map(row => row.map(quote).join(',')).join('\r\n')}\r\n`
}

/** `kontakty-1250.csv`: what an old Excel writes in Windows-1250, which Helm refuses (UTF-8/UTF-16 only). */
export function buildWindows1250(): Uint8Array {
	// "Jméno;Příjmení\r\nPetra;Nováková\r\n" with é=0xE9, ř=0xF8, í=0xED, á=0xE1.
	const text = 'Jméno;Příjmení\r\nPetra;Nováková\r\n'
	const map: Record<string, number> = { é: 0xe9, ř: 0xf8, í: 0xed, á: 0xe1 }
	return Uint8Array.from([...text].map(char => map[char] ?? char.charCodeAt(0)))
}
