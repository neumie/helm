#!/usr/bin/env node
// Story-only fixture generator for the `helm open` design prototypes
// (docs/plans/helm-open/spec.md). Writes realistic sample files into
// src/renderer/open-prototype/fixtures/. Deterministic: no clock, no random.
//
//   node scripts/open-prototype-fixtures.mjs
//
// Needs Playwright's Chromium (PDF + PNG), SheetJS (XLSX/ODS) and macOS
// textutil (DOCX). Not part of any build.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import JSZip from 'jszip'
import * as XLSX from 'xlsx'

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, '../src/renderer/open-prototype/fixtures')
mkdirSync(out, { recursive: true })

// Deterministic pseudo-random (mulberry32).
function rng(seed) {
	let a = seed >>> 0
	return () => {
		a = (a + 0x6d2b79f5) >>> 0
		let t = a
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}
const rand = rng(20261109)
const pick = list => list[Math.floor(rand() * list.length)]

const clients = [
	'Psyon s.r.o.',
	'Nordic Freight AB',
	'Kavárna Lípa',
	'Dentium Clinic',
	'Brno Makers Lab',
	'Ostrava Steelworks',
	'Fakturoid a.s.',
	'Mountain Retreats',
	'Vltava Logistics',
	'Atelier Novák',
]
const services = ['Retainer', 'Feature work', 'Incident response', 'Hosting', 'Design review', 'Consulting']

// ---------- CSV + XLSX + ODS ----------
const invoices = []
for (let i = 0; i < 1800; i++) {
	const month = 1 + (i % 10)
	const day = 1 + Math.floor(rand() * 27)
	const net = Math.round((800 + rand() * 42000) / 10) * 10
	const status = rand() < 0.08 ? 'Overdue' : rand() < 0.2 ? 'Sent' : 'Paid'
	invoices.push({
		Number: `2026-${String(i + 1).padStart(4, '0')}`,
		Issued: `2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
		Client: pick(clients),
		Service: pick(services),
		'Net CZK': net,
		'VAT CZK': Math.round(net * 0.21),
		'Total CZK': Math.round(net * 1.21),
		Status: status,
	})
}
const header = Object.keys(invoices[0])
const csvCell = value => {
	const text = String(value)
	return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}
writeFileSync(
	join(out, 'invoices-2026.csv'),
	`${[header.join(','), ...invoices.map(row => header.map(key => csvCell(row[key])).join(','))].join('\n')}\n`,
)

const workbook = XLSX.utils.book_new()
const invoiceRows = invoices.slice(0, 240)
const sheet1 = XLSX.utils.json_to_sheet(invoiceRows)
sheet1['!cols'] = [
	{ wch: 11 },
	{ wch: 11 },
	{ wch: 22 },
	{ wch: 18 },
	{ wch: 11 },
	{ wch: 11 },
	{ wch: 11 },
	{ wch: 9 },
]
sheet1['!autofilter'] = { ref: `A1:H${invoiceRows.length + 1}` }
XLSX.utils.book_append_sheet(workbook, sheet1, 'Invoices')
const summary = [['Client', 'Invoices', 'Net CZK', 'Total CZK', 'Share']]
clients.forEach((client, index) => {
	const r = index + 2
	summary.push([
		client,
		{ t: 'n', f: `COUNTIF(Invoices!C:C,A${r})` },
		{ t: 'n', f: `SUMIF(Invoices!C:C,A${r},Invoices!E:E)` },
		{ t: 'n', f: `SUMIF(Invoices!C:C,A${r},Invoices!G:G)` },
		{ t: 'n', f: `D${r}/D${clients.length + 2}`, z: '0.0%' },
	])
})
const totalRow = clients.length + 2
summary.push([
	'Total',
	{ t: 'n', f: `SUM(B2:B${totalRow - 1})` },
	{ t: 'n', f: `SUM(C2:C${totalRow - 1})` },
	{ t: 'n', f: `SUM(D2:D${totalRow - 1})` },
	{ t: 'n', f: `SUM(E2:E${totalRow - 1})`, z: '0.0%' },
])
// Cached values so viewers that do not evaluate formulas still show numbers.
const sheet2 = XLSX.utils.aoa_to_sheet(summary)
clients.forEach((client, index) => {
	const rows = invoiceRows.filter(row => row.Client === client)
	const r = index + 2
	sheet2[`B${r}`].v = rows.length
	sheet2[`C${r}`].v = rows.reduce((sum, row) => sum + row['Net CZK'], 0)
	sheet2[`D${r}`].v = rows.reduce((sum, row) => sum + row['Total CZK'], 0)
})
const grand = invoiceRows.reduce((sum, row) => sum + row['Total CZK'], 0)
clients.forEach((_, index) => {
	const r = index + 2
	sheet2[`E${r}`].v = sheet2[`D${r}`].v / grand
})
sheet2[`B${totalRow}`].v = invoiceRows.length
sheet2[`C${totalRow}`].v = invoiceRows.reduce((sum, row) => sum + row['Net CZK'], 0)
sheet2[`D${totalRow}`].v = grand
sheet2[`E${totalRow}`].v = 1
sheet2['!cols'] = [{ wch: 22 }, { wch: 9 }, { wch: 13 }, { wch: 13 }, { wch: 8 }]
XLSX.utils.book_append_sheet(workbook, sheet2, 'Summary')
writeFileSync(
	join(out, 'invoicing-2026.xlsx'),
	XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', compression: true }),
)

// ---------- JSON / JSONL ----------
const issue = {
	id: '6123987402',
	shortId: 'PSYON-API-3F',
	title: "TypeError: Cannot read properties of undefined (reading 'ico')",
	culprit: 'companies/create.ts in saveFirm',
	level: 'error',
	status: 'unresolved',
	firstSeen: '2026-11-02T08:14:51.000Z',
	lastSeen: '2026-11-09T07:41:03.000Z',
	count: 418,
	userCount: 37,
	project: { slug: 'psyon-api', platform: 'node' },
	tags: [
		{ key: 'environment', value: 'production' },
		{ key: 'release', value: 'psyon-api@4.18.2' },
		{ key: 'browser', value: 'Chrome 141' },
	],
	latestEvent: {
		eventId: 'b1f6c5d0e2a94c1c9a3f7e8d2c41b0aa',
		request: {
			method: 'POST',
			url: 'https://api.psyon.cz/v2/companies',
			headers: { 'content-type': 'application/json' },
		},
		exception: {
			values: [
				{
					type: 'TypeError',
					value: "Cannot read properties of undefined (reading 'ico')",
					stacktrace: {
						frames: [
							{
								filename: 'node:internal/process/task_queues',
								function: 'processTicksAndRejections',
								lineno: 95,
								inApp: false,
							},
							{ filename: 'src/routes/companies.ts', function: 'createCompany', lineno: 61, inApp: true },
							{ filename: 'src/companies/create.ts', function: 'saveFirm', lineno: 118, colno: 27, inApp: true },
						],
					},
				},
			],
		},
		breadcrumbs: Array.from({ length: 6 }, (_, index) => ({
			timestamp: `2026-11-09T07:40:${String(40 + index * 3).padStart(2, '0')}.000Z`,
			category: index % 2 ? 'http' : 'query',
			message:
				index % 2 ? 'GET https://ares.gov.cz/ekonomicke-subjekty/27074358' : 'SELECT * FROM company WHERE ico = $1',
			level: 'info',
		})),
	},
}
writeFileSync(join(out, 'sentry-issue.json'), `${JSON.stringify(issue, null, 2)}\n`)

// ---------- Markdown ----------
writeFileSync(
	join(out, 'company-create-plan.md'),
	`# Fix: company create loses the firm on save

The ARES lookup returns \`undefined\` for companies that changed their legal form,
and \`saveFirm\` dereferences \`ares.ico\` before checking it.

## What happens today

1. The user types an IČO and picks the company from the suggestion list.
2. \`createCompany\` calls ARES, then \`saveFirm(ares, input)\`.
3. ARES answers **404** for a dissolved legal form, so \`ares\` is \`undefined\`.
4. \`saveFirm\` throws \`TypeError\` and the form shows a generic error.

## Proposed change

- Treat a missing ARES record as *unverified*, not as an error.
- Keep the IČO the user typed; mark the company \`verification: 'pending'\`.
- Re-check pending companies nightly.

| Case | Today | After |
| --- | --- | --- |
| ARES found | saved | saved |
| ARES 404 | 500 error | saved, pending |
| ARES timeout | 500 error | saved, pending, retried |

\`\`\`ts
const ares = await lookupAres(input.ico).catch(() => undefined)
return saveFirm({ ...input, verification: ares ? 'verified' : 'pending' })
\`\`\`

## Open questions

- Should a pending company be invoiceable?
- Who gets notified when the nightly check fails twice?
`,
)

// ---------- Code ----------
writeFileSync(join(out, 'refusal.ts'), readFileSync(join(here, '../../src/document-review/refusal.ts'), 'utf8'))

// ---------- DOCX (hand-written OOXML, see writeDocx) ----------
const scratch = mkdtempSync(join(tmpdir(), 'helm-open-fixtures-'))
try {
	await writeDocx(join(out, 'service-agreement.docx'))

	// ---------- PDF + PNG (Chromium) ----------
	const browser = await chromium.launch()
	const page = await browser.newPage({ viewport: { width: 1200, height: 760 }, deviceScaleFactor: 2 })
	const bars = clients
		.map((client, index) => {
			const value = invoiceRows.filter(row => row.Client === client).reduce((s, r) => s + r['Total CZK'], 0)
			return { client, value, index }
		})
		.sort((a, b) => b.value - a.value)
	const max = bars[0].value
	const reportPages = []
	reportPages.push(`<section><h1>Platform report — October 2026</h1><p class="lede">Psyon API, onboarding and invoicing. Prepared for the November review.</p>
<h2>Summary</h2><p>Request volume grew 14% month over month while p95 latency fell from 412 ms to 268 ms after the ARES cache landed on 14 October. The company-create error rate is still above target: 418 events from 37 users, all traced to a missing ARES record for companies that changed their legal form.</p>
<table><tr><th>Metric</th><th>September</th><th>October</th><th>Change</th></tr>
<tr><td>Requests</td><td>2.41 M</td><td>2.75 M</td><td>+14%</td></tr>
<tr><td>p95 latency</td><td>412 ms</td><td>268 ms</td><td>−35%</td></tr>
<tr><td>Error rate</td><td>0.61%</td><td>0.38%</td><td>−0.23 pt</td></tr>
<tr><td>Invoices issued</td><td>171</td><td>186</td><td>+9%</td></tr></table>
<h2>Revenue by client</h2>
<div class="chart">${bars
		.map(
			bar =>
				`<div class="row"><span>${bar.client}</span><i style="width:${Math.round((bar.value / max) * 100)}%"></i><b>${bar.value.toLocaleString('cs-CZ')}</b></div>`,
		)
		.join('')}</div></section>`)
	reportPages.push(`<section><h2>Incidents</h2><p>Two incidents breached the one-business-day response target. Both were weekend pages for the Fakturoid webhook relay.</p>
<ol><li><b>12 Oct</b> — Webhook relay queue stalled after a certificate rotation. Resolved in 3 h 10 min.</li><li><b>26 Oct</b> — ARES rate limiting during the monthly re-verification batch. Resolved by spreading the batch over six hours.</li></ol>
<h2>Next month</h2><ul><li>Ship the pending-verification state for company create.</li><li>Move the nightly ARES re-check off the main worker.</li><li>Quarterly security review: dependency audit and token rotation.</li></ul>
<h2>Notes</h2>${Array.from({ length: 6 }, (_, i) => `<p>${'The onboarding funnel now records each step separately, so drop-off between IČO lookup and the bank details form is visible for the first time. '.repeat(1 + (i % 3))}</p>`).join('')}</section>`)
	reportPages.push(`<section><h2>Appendix A — Error budget</h2><table><tr><th>Week</th><th>Budget used</th><th>Main cause</th></tr>${Array.from({ length: 5 }, (_, i) => `<tr><td>W${40 + i}</td><td>${[34, 61, 18, 47, 22][i]}%</td><td>${['ARES timeouts', 'Webhook relay', 'Deploy rollback', 'ARES 404s', 'None'][i]}</td></tr>`).join('')}</table>
<h2>Appendix B — Glossary</h2><dl><dt>ARES</dt><dd>The Czech business register API used to verify an IČO.</dd><dt>IČO</dt><dd>Company identification number.</dd><dt>p95</dt><dd>The latency 95% of requests stay under.</dd></dl></section>`)
	await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
@page{size:A4;margin:22mm 20mm}
body{font-family:-apple-system,'Helvetica Neue',sans-serif;color:#1d1f23;font-size:10.5pt;line-height:1.5}
section{page-break-after:always} section:last-child{page-break-after:auto}
h1{font-size:22pt;margin:0 0 4pt} h2{font-size:13pt;margin:18pt 0 6pt} .lede{color:#555;margin:0 0 14pt}
table{border-collapse:collapse;width:100%;margin:6pt 0} th,td{text-align:left;padding:4pt 6pt;border-bottom:0.5pt solid #ccc} th{font-weight:600}
.chart .row{display:grid;grid-template-columns:120pt 1fr 70pt;align-items:center;gap:6pt;margin:3pt 0}
.chart i{display:block;height:9pt;background:#3b6fb6;border-radius:2pt} .chart b{font-weight:500;text-align:right;font-variant-numeric:tabular-nums}
</style></head><body>${reportPages.join('')}</body></html>`)
	await page.pdf({
		path: join(out, 'platform-report-2026-10.pdf'),
		format: 'A4',
		printBackground: true,
		displayHeaderFooter: true,
		headerTemplate: '<span></span>',
		footerTemplate:
			'<div style="font-size:8pt;color:#888;width:100%;text-align:center;font-family:sans-serif"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
	})

	// A realistic screenshot: an onboarding form with the error state.
	await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;font-family:-apple-system,sans-serif;background:#f4f5f7;color:#1d1f23}
.top{height:56px;background:#fff;border-bottom:1px solid #e3e5e8;display:flex;align-items:center;padding:0 28px;gap:24px;font-weight:600}
.top span{font-weight:400;color:#666}
main{max-width:720px;margin:40px auto;background:#fff;border:1px solid #e3e5e8;border-radius:10px;padding:32px 36px}
h1{font-size:22px;margin:0 0 6px} p{color:#666;margin:0 0 24px}
label{display:block;font-size:13px;font-weight:600;margin:16px 0 6px} input{width:100%;box-sizing:border-box;height:40px;border:1px solid #cfd3d8;border-radius:6px;padding:0 12px;font-size:15px}
.err{margin-top:24px;background:#fdecec;border:1px solid #f3b8b8;color:#9b1c1c;border-radius:8px;padding:12px 14px;font-size:14px}
button{margin-top:24px;height:40px;padding:0 20px;border:0;border-radius:6px;background:#2f6fdb;color:#fff;font-size:15px;font-weight:600}
.steps{display:flex;gap:10px;margin-bottom:22px;font-size:13px;color:#888} .steps b{color:#2f6fdb}
</style></head><body><div class="top">Psyon <span>Companies</span><span>Invoices</span><span>Settings</span></div>
<main><div class="steps"><b>1 Company</b> · 2 Bank details · 3 Confirm</div><h1>Add a company</h1><p>Look the company up by IČO. Details are filled in from ARES.</p>
<label>IČO</label><input value="27074358"><label>Company name</label><input value="Psyon s.r.o."><label>Address</label><input value="Údolní 53, 602 00 Brno">
<div class="err">Something went wrong while saving the company. Try again later.</div><button>Save company</button></main></body></html>`)
	await page.screenshot({ path: join(out, 'company-create-error.png') })
	await browser.close()
} finally {
	rmSync(scratch, { recursive: true, force: true })
}
console.log(`fixtures written to ${out}`)

async function writeDocx(path) {
	const esc = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
	const run = (text, props = '') =>
		`<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`
	const para = (runs, style) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}${runs}</w:p>`
	const bullet = text =>
		`<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>${run(text)}</w:p>`
	const cell = (text, header) =>
		`<w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/></w:tcPr>${para(run(text, header ? '<w:b/>' : ''))}</w:tc>`
	const row = (cells, header) => `<w:tr>${cells.map(text => cell(text, header)).join('')}</w:tr>`
	const table = rows =>
		`<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="9000" w:type="dxa"/></w:tblPr><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid>${rows.map((cells, index) => row(cells, index === 0)).join('')}</w:tbl>`
	const body = [
		para(run('Service agreement'), 'Title'),
		para(
			`${run('Between ', '<w:b/>')}${run('Psyon s.r.o., IČO 27074358 (the ')}${run('Client', '<w:i/>')}${run(') and Jakub Neumann, IČO 08812345 (the ')}${run('Contractor', '<w:i/>')}${run(').')}`,
		),
		para(run('1. Scope'), 'Heading1'),
		para(
			run(
				'The Contractor maintains the Psyon API and the company onboarding flow, including incident response within one business day.',
			),
		),
		bullet('Bug fixes reported through ClientCare'),
		bullet('Monthly dependency updates'),
		bullet('Quarterly security review'),
		para(run('2. Fees'), 'Heading1'),
		table([
			['Item', 'Rate', 'Billing'],
			['Retainer', '24 000 CZK', 'Monthly'],
			['Additional work', '1 400 CZK / hour', 'Monthly in arrears'],
			['Incident outside hours', '2 100 CZK / hour', 'Per incident'],
		]),
		para(run('3. Term'), 'Heading1'),
		para(
			`${run('This agreement starts on 1 December 2026 and continues until either party ends it with ')}${run('two months’', '<w:b/>')}${run(' written notice.')}`,
		),
		para(run('4. Confidentiality'), 'Heading1'),
		para(
			run(
				'Both parties keep the other’s non-public information confidential during the term and for three years after it ends.',
			),
		),
		para(run('5. Signatures'), 'Heading1'),
		table([
			['Client', 'Contractor', 'Date'],
			['__________________', '__________________', '1 December 2026'],
		]),
	].join('')
	const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
	const style = (id, name, rpr, ppr = '') =>
		`<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:qFormat/>${ppr ? `<w:pPr>${ppr}</w:pPr>` : ''}<w:rPr>${rpr}</w:rPr></w:style>`
	const zip = new JSZip()
	zip.file(
		'[Content_Types].xml',
		'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>',
	)
	zip.file(
		'_rels/.rels',
		'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
	)
	zip.file(
		'word/_rels/document.xml.rels',
		'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>',
	)
	zip.file(
		'word/styles.xml',
		`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${W}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Georgia" w:hAnsi="Georgia"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>${style('Title', 'Title', '<w:b/><w:sz w:val="40"/>')}${style('Heading1', 'heading 1', '<w:b/><w:sz w:val="28"/>', '<w:keepNext/><w:spacing w:before="240" w:after="80"/>')}${style('ListParagraph', 'List Paragraph', '', '<w:ind w:left="720"/><w:spacing w:after="40"/>')}<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:color="999999"/><w:left w:val="single" w:sz="4" w:color="999999"/><w:bottom w:val="single" w:sz="4" w:color="999999"/><w:right w:val="single" w:sz="4" w:color="999999"/><w:insideH w:val="single" w:sz="4" w:color="999999"/><w:insideV w:val="single" w:sz="4" w:color="999999"/></w:tblBorders><w:tblCellMar><w:left w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style></w:styles>`,
	)
	zip.file(
		'word/numbering.xml',
		`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering ${W}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`,
	)
	zip.file(
		'word/document.xml',
		`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`,
	)
	writeFileSync(
		path,
		await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', date: new Date(Date.UTC(2026, 10, 9)) }),
	)
}
