// Authoring tool for the checked-in PDF fixtures of the plain viewer (src/renderer/viewer/fixtures/pdf/). Not a build
// step. Chromium prints realistic documents (embedded fonts, tagged text, an outline from the headings); Ghostscript
// encrypts the locked one; macOS `sips` makes the JPEG 2000 picture that pdf-fixture-builder.ts wraps in a PDF. The
// hand-built fixtures (500 pages, CJK CMaps, JBIG2, JPEG 2000, active content) are made at run time by
// src/renderer/viewer/pdf-fixture-builder.ts instead.
//
//   cd app && node scripts/write-pdf-fixtures.mjs
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from '@playwright/test'

const out = new URL('../src/renderer/viewer/fixtures/pdf/', import.meta.url).pathname
const style = `
	@page { size: A4; margin: 22mm 20mm; }
	body { font: 10.5pt/1.5 "Helvetica Neue", Helvetica, Arial, sans-serif; color: #1d1d1f; }
	h1 { font-size: 22pt; margin: 0 0 4pt; letter-spacing: -0.01em; }
	h2 { font-size: 14pt; margin: 20pt 0 6pt; break-after: avoid; }
	h3 { font-size: 11pt; margin: 14pt 0 4pt; break-after: avoid; }
	.lede { color: #555; margin: 0 0 18pt; }
	table { width: 100%; border-collapse: collapse; margin: 6pt 0 12pt; font-size: 9.5pt; }
	th, td { text-align: left; padding: 4pt 6pt; border-bottom: 0.5pt solid #ccc; vertical-align: top; }
	th { font-weight: 600; }
	td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
	.page { break-before: page; }
	.bar { display: inline-block; height: 7pt; background: #3a6ee8; vertical-align: middle; }
	.note { color: #555; font-size: 9pt; }
`
const incidents = [
	['INC-2291', '3 Oct', 'Invoice PDF export timed out for workbooks over 40 sheets', 'Sev 2', '41 min'],
	['INC-2294', '7 Oct', 'Login loop after session refresh on Safari 19', 'Sev 2', '1 h 12 min'],
	['INC-2301', '12 Oct', 'Company create form saved without IČO validation', 'Sev 3', '3 h 05 min'],
	['INC-2307', '18 Oct', 'Search index lag (up to 9 min) after bulk import', 'Sev 3', '2 h 40 min'],
	['INC-2312', '24 Oct', 'Android camera permission prompt repeated on every upload', 'Sev 3', '5 h 20 min'],
	['INC-2318', '29 Oct', 'Webhook retries doubled delivery to two partner endpoints', 'Sev 2', '58 min'],
]
const deploys = Array.from({ length: 22 }, (_, index) => {
	const day = 1 + index + Math.floor(index / 5) * 2
	return [
		`${Math.min(day, 31)} Oct`,
		['web', 'api', 'worker', 'mobile'][index % 4],
		`v4.${18 + Math.floor(index / 3)}.${index % 3}`,
		index % 7 === 3 ? 'Rolled back' : 'Healthy',
	]
})
const report = `<!doctype html><meta charset="utf-8"><style>${style}</style>
<h1>Platform report, October 2026</h1>
<p class="lede">ClientCare platform team · prepared 3 November 2026 · internal</p>
<h2>Summary</h2>
<p>October closed with 99.95% availability across the public API and the web app, slightly under the 99.97% target
because of two severity 2 incidents in the first week. Median request latency improved from 182 ms to 154 ms after the
connection-pool change shipped on 9 October. Twenty-two production deploys went out; one was rolled back.</p>
<p>The invoicing workbook export remains the slowest user-facing path. The fix for workbooks over forty sheets is in
review and is expected to ship in the second week of November.</p>
<h3>Highlights</h3>
<ul>
<li>Session refresh is now handled server-side; the Safari login loop cannot recur.</li>
<li>IČO validation moved into the shared company form, so every create path checks it.</li>
<li>Search indexing runs incrementally after bulk imports instead of rebuilding the index.</li>
</ul>
<h2>Availability</h2>
<table><tr><th>Service</th><th class="num">Target</th><th class="num">Actual</th><th class="num">Minutes down</th></tr>
<tr><td>Public API</td><td class="num">99.97%</td><td class="num">99.95%</td><td class="num">22</td></tr>
<tr><td>Web app</td><td class="num">99.97%</td><td class="num">99.96%</td><td class="num">18</td></tr>
<tr><td>Background workers</td><td class="num">99.90%</td><td class="num">99.93%</td><td class="num">31</td></tr>
<tr><td>Mobile API</td><td class="num">99.95%</td><td class="num">99.98%</td><td class="num">9</td></tr></table>
<p class="note">Minutes down count user-visible errors above 1% of requests for at least one minute.</p>
<h2 class="page">Incidents</h2>
<p>Six incidents were opened in October. Every one has a written follow-up; the two severity 2 incidents also have a
review with the affected clients.</p>
<table><tr><th>ID</th><th>Date</th><th>What happened</th><th>Severity</th><th class="num">Duration</th></tr>
${incidents.map(row => `<tr>${row.map((cell, index) => `<td${index === 4 ? ' class="num"' : ''}>${cell}</td>`).join('')}</tr>`).join('')}</table>
<h3>Follow-ups</h3>
<p>The webhook retry incident (INC-2318) came from a retry queue that did not record which endpoints had already
acknowledged a delivery. Deliveries now carry an idempotency key, and both partners confirmed their endpoints
deduplicate on it. The invoice export timeout (INC-2291) is tracked as PLAT-881.</p>
<h2>Latency</h2>
<table><tr><th>Endpoint</th><th class="num">p50</th><th class="num">p95</th><th class="num">p99</th><th>Trend</th></tr>
${[
	['GET /companies', 92, 240, 610, 34],
	['POST /invoices', 210, 690, 1480, 52],
	['GET /invoices/:id/pdf', 1450, 4210, 9800, 88],
	['POST /uploads', 310, 980, 2210, 61],
	['GET /search', 120, 330, 890, 40],
]
	.map(
		([name, p50, p95, p99, bar]) =>
			`<tr><td>${name}</td><td class="num">${p50} ms</td><td class="num">${p95} ms</td><td class="num">${p99} ms</td><td><span class="bar" style="width:${bar}pt"></span></td></tr>`,
	)
	.join('')}</table>
<h2 class="page">Deploys</h2>
<p>Deploys are listed by day and service. A rollback is a deploy that was reverted within the hour.</p>
<table><tr><th>Date</th><th>Service</th><th>Version</th><th>Outcome</th></tr>
${deploys.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('')}</table>
<h2 class="page">Costs</h2>
<p>Infrastructure spend was €18,420, 4% under budget. Storage grew with the uploads feature; compute fell after the
worker pool was right-sized.</p>
<table><tr><th>Item</th><th class="num">September</th><th class="num">October</th><th class="num">Change</th></tr>
<tr><td>Compute</td><td class="num">€9,880</td><td class="num">€9,140</td><td class="num">−7.5%</td></tr>
<tr><td>Database</td><td class="num">€4,210</td><td class="num">€4,260</td><td class="num">+1.2%</td></tr>
<tr><td>Storage and transfer</td><td class="num">€2,640</td><td class="num">€3,310</td><td class="num">+25.4%</td></tr>
<tr><td>Monitoring</td><td class="num">€1,690</td><td class="num">€1,710</td><td class="num">+1.2%</td></tr></table>
<h2>Appendix: definitions</h2>
<h3>Availability</h3>
<p>The share of one-minute windows in which fewer than 1% of requests failed with a server error or timed out.</p>
<h3>Severity</h3>
<p>Severity 1 stops all clients; severity 2 stops a feature for many clients; severity 3 degrades a feature or affects
a few clients.</p>`

const deliveryNote = `<!doctype html><meta charset="utf-8"><style>
	body { margin: 0; width: 1240px; height: 1754px; background: #f4f2ec; font: 26px/1.45 "Courier New", monospace; color: #222; }
	.sheet { padding: 110px 120px; transform: rotate(-0.6deg); transform-origin: 50% 50%; filter: grayscale(1) contrast(1.15); }
	h1 { font: bold 46px Helvetica, Arial, sans-serif; margin: 0 0 30px; }
	table { width: 100%; border-collapse: collapse; margin: 30px 0; }
	td, th { border-bottom: 2px solid #555; padding: 10px 6px; text-align: left; }
	.sign { margin-top: 120px; font: italic 40px "Snell Roundhand", cursive; }
</style><div class="sheet">
<h1>DELIVERY NOTE  No. 2026-1043</h1>
<p>Supplier: Kancelářské potřeby Brno s.r.o.<br>Customer: ClientCare a.s., Vídeňská 12, Brno<br>Date: 21. 10. 2026</p>
<table><tr><th>Item</th><th>Qty</th><th>Unit</th></tr>
<tr><td>A4 copy paper, 80 g</td><td>40</td><td>ream</td></tr>
<tr><td>Toner HP 59A</td><td>6</td><td>pcs</td></tr>
<tr><td>Archive box, 75 mm</td><td>25</td><td>pcs</td></tr>
<tr><td>Whiteboard markers, set of 4</td><td>12</td><td>set</td></tr></table>
<p>Received complete and undamaged.</p>
<p class="sign">J. Novák</p>
</div>`

const agreement = `<!doctype html><meta charset="utf-8"><style>${style}</style>
<h1>Service agreement</h1>
<p class="lede">Between ClientCare a.s. and Northwind Analytics s.r.o. · signed 14 October 2026</p>
<h2>1. Services</h2>
<p>Northwind Analytics provides monthly data quality reviews of the invoicing database, including duplicate detection,
VAT number validation and a written report with recommended corrections.</p>
<h2>2. Fees</h2>
<p>The monthly fee is €2,400 excluding VAT, invoiced at the end of each month and payable within 14 days.</p>
<h2>3. Confidentiality</h2>
<p>Both parties keep client data confidential and process it only to provide the services.</p>
<h2 class="page">4. Term</h2>
<p>The agreement runs for twelve months and renews for twelve more unless either party gives notice two months
before the end of a term.</p>`

const browser = await chromium.launch()
try {
	const page = await browser.newPage()
	await page.setContent(report, { waitUntil: 'load' })
	await page.pdf({
		path: join(out, 'platform-report-2026-10.pdf'),
		format: 'A4',
		outline: true,
		tagged: true,
		printBackground: true,
	})
	const scan = await browser.newPage({ viewport: { width: 1240, height: 1754 } })
	await scan.setContent(deliveryNote, { waitUntil: 'load' })
	const png = await scan.screenshot({ type: 'jpeg', quality: 72 })
	await page.setContent(
		`<!doctype html><style>@page{size:A4;margin:0}body{margin:0}img{display:block;width:210mm;height:297mm}</style><img src="data:image/jpeg;base64,${png.toString('base64')}">`,
		{ waitUntil: 'load' },
	)
	await page.pdf({ path: join(out, 'scanned-delivery-note.pdf'), format: 'A4', printBackground: true })
	const temp = mkdtempSync(join(tmpdir(), 'helm-pdf-fixtures-'))
	try {
		await page.setContent(agreement, { waitUntil: 'load' })
		await page.pdf({ path: join(temp, 'agreement.pdf'), format: 'A4', tagged: true })
		// The password is part of the fixture (stories and tests type it): helm-2026.
		execFileSync('gs', [
			'-q',
			'-dSAFER',
			'-dBATCH',
			'-dNOPAUSE',
			'-sDEVICE=pdfwrite',
			'-dEncryptionR=3',
			'-dKeyLength=128',
			'-sOwnerPassword=northwind-owner',
			'-sUserPassword=helm-2026',
			`-sOutputFile=${join(out, 'service-agreement-locked.pdf')}`,
			join(temp, 'agreement.pdf'),
		])
	} finally {
		rmSync(temp, { recursive: true, force: true })
	}
} finally {
	await browser.close()
}
execFileSync('sips', [
	'-s',
	'format',
	'jp2',
	'-s',
	'formatOptions',
	'60',
	new URL('../src/renderer/viewer/fixtures/images/form-error.jpg', import.meta.url).pathname,
	'--out',
	join(out, 'form-error.jp2'),
])
console.log(`PDF fixtures written to ${out}`)
