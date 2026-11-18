// Signals review fixtures (Views / Signals): SignalThread rows, a dock snapshot and in-memory fakes of
// the column's services, so stories and browser tests drive the PRODUCTION column. Nothing here
// polls GitHub, Mail or Okena, and nothing is imported by production renderer code.

import type {
	AgentDockActRequest,
	AgentDockPromptRequest,
	AgentDockSnapshot,
	DockActOutcome,
	DockItem,
	DockSession,
} from '../../agent-dock/model'
import type { SignalNewAgentRequest, SignalOkenaProject, SignalsBridgeState } from '../../shared'
import type { HelmResult } from '../../shared-helm'
import type {
	SignalFilteredEntry,
	SignalSourceHealth,
	SignalThread,
	SignalUpdate,
	SignalsSnapshot,
} from '../../shared-helm'
import { SignalsAskResolver } from '../../signals-ask-resolver'
import { nextWeekdayMorning } from './model'
import type { DockService, SignalsService } from './services'

const MINUTE = 60_000
const iso = (at: number): string => new Date(at).toISOString()

type ThreadSeed = Partial<SignalThread> &
	Pick<SignalThread, 'id' | 'threadKey' | 'source' | 'kind' | 'ref' | 'fullRef' | 'title' | 'head'> & {
		/** Minutes before `now` of the latest foreign activity. */
		ago: number
	}

function thread(seed: ThreadSeed, now: number): SignalThread {
	const { ago, ...rest } = seed
	const at = iso(now - ago * MINUTE)
	return {
		reasons: [seed.kind],
		actor: null,
		url: null,
		repo: null,
		number: null,
		branch: null,
		state: 'new',
		owner: 'jakub',
		snoozedUntil: null,
		lastActivityAt: at,
		active: true,
		closedReason: null,
		note: null,
		noteAt: null,
		managedBy: null,
		routedAgent: null,
		routedHow: null,
		routedAt: null,
		body: null,
		links: [],
		askTerminal: null,
		reply: null,
		replyAt: null,
		createdAt: at,
		updatedAt: at,
		...rest,
	}
}

/** The threads every Signals story shows. Handles other than matej21 are illustrative. */
export function signalThreadFixtures(now = Date.now()): SignalThread[] {
	return [
		thread(
			{
				id: 311,
				threadKey: 'github:contember/okena#311',
				source: 'github',
				kind: 'review',
				ref: 'okena#311',
				fullRef: 'contember/okena#311',
				title: 'Claude dialogs answered in the terminal stay listed',
				head: 'review requested · matej21',
				actor: 'matej21',
				url: 'https://github.com/contember/okena/pull/311',
				repo: 'contember/okena',
				number: 311,
				branch: 'fix/dialog-listed-after-answer',
				ago: 8,
			},
			now,
		),
		thread(
			{
				id: 970,
				threadKey: 'github:contember-external/crane-rental#970',
				source: 'github',
				kind: 'comments',
				reasons: ['comments', 'ci'],
				ref: 'crane-rental#970',
				fullRef: 'contember-external/crane-rental#970',
				title: 'Offer PDF export',
				head: '2 comments · lukas-h',
				actor: 'lukas-h',
				url: 'https://github.com/contember-external/crane-rental/pull/970',
				repo: 'contember-external/crane-rental',
				number: 970,
				branch: 'feat/offer-pdf-export',
				ago: 23,
			},
			now,
		),
		thread(
			{
				id: 42,
				threadKey: 'sentry:PSYON-ADMIN-3F2',
				source: 'mail',
				kind: 'sentry',
				ref: 'PSYON-ADMIN-3F2',
				fullRef: 'Sentry <alerts@sentry.io>',
				title: "TypeError: Cannot read properties of undefined (reading 'slots')",
				head: "TypeError: Cannot read properties of undefined (reading 'slots')",
				actor: 'Sentry',
				url: 'message://%3Calert-3f2%40sentry.io%3E',
				ago: 64,
			},
			now,
		),
		thread(
			{
				id: 43,
				threadKey: 'mail:5f1c0e9d2a7b4c11',
				source: 'mail',
				kind: 'mail',
				ref: 'Psyon',
				fullRef: 'Klára D. <klara@psyon.example>',
				title: 'Nefunguje export rezervací do Excelu',
				head: 'Nefunguje export rezervací do Excelu',
				actor: 'Klára D.',
				url: 'message://%3Cexport-rezervaci%40psyon.example%3E',
				state: 'seen',
				routedAgent: 'reservations-export',
				routedHow: 'sent',
				routedAt: iso(now - 3 * MINUTE),
				ago: 182,
			},
			now,
		),
		thread(
			{
				id: 304,
				threadKey: 'github:contember/okena#304',
				source: 'github',
				kind: 'review',
				ref: 'okena#304',
				fullRef: 'contember/okena#304',
				title: 'Claude dialog answered in terminal',
				head: 'changes requested · matej21',
				actor: 'matej21',
				url: 'https://github.com/contember/okena/pull/304',
				repo: 'contember/okena',
				number: 304,
				branch: 'fix/claude-dialog-answered-in-terminal',
				state: 'seen',
				owner: 'managed',
				managedBy: 'claude-dialog-answered-in-terminal',
				note: 'round 2 · pushed 7c1e0b2 · CI passing',
				noteAt: iso(now - 14 * MINUTE),
				ago: 52,
			},
			now,
		),
		thread(
			{
				id: 44,
				threadKey: 'mail:9a0b3c7d1e2f4a55',
				source: 'mail',
				kind: 'mail',
				ref: 'JVS',
				fullRef: 'Pavel Š. <pavel@jvs.example>',
				title: 'Re: Import ceníku do e-shopu',
				head: 'Re: Import ceníku do e-shopu · 3 messages',
				actor: 'Pavel Š.',
				url: 'message://%3Cimport-ceniku%40jvs.example%3E',
				state: 'seen',
				owner: 'managed',
				managedBy: 'pricelist-import',
				note: 'reply drafted in Mail',
				noteAt: iso(now - 41 * MINUTE),
				ago: 95,
			},
			now,
		),
		thread(
			{
				id: 45,
				threadKey: 'mail:77aa01bc9d3e4f20',
				source: 'mail',
				kind: 'mail',
				ref: 'Hetzner',
				fullRef: 'Hetzner Online <noreply@hetzner.example>',
				title: 'Plánovaná údržba 14. 11.',
				head: 'Plánovaná údržba 14. 11.',
				actor: 'Hetzner Online',
				url: 'message://%3Cudrzba%40hetzner.example%3E',
				state: 'snoozed',
				snoozedUntil: nextWeekdayMorning(now).toISOString(),
				ago: 300,
			},
			now,
		),
		thread(
			{
				id: 298,
				threadKey: 'github:contember/okena#298',
				source: 'github',
				kind: 'review',
				ref: 'okena#298',
				fullRef: 'contember/okena#298',
				title: 'Stream reconnect backoff',
				head: 'review requested · matej21',
				actor: 'matej21',
				url: 'https://github.com/contember/okena/pull/298',
				repo: 'contember/okena',
				number: 298,
				state: 'done',
				active: false,
				closedReason: 'no longer open or requested',
				updatedAt: iso(now - 140 * MINUTE),
				ago: 300,
			},
			now,
		),
		thread(
			{
				id: 965,
				threadKey: 'github:contember-external/crane-rental#965',
				source: 'github',
				kind: 'comments',
				ref: 'crane-rental#965',
				fullRef: 'contember-external/crane-rental#965',
				title: 'Rental calendar sync',
				head: '1 comment · lukas-h',
				actor: 'lukas-h',
				url: 'https://github.com/contember-external/crane-rental/pull/965',
				repo: 'contember-external/crane-rental',
				number: 965,
				state: 'done',
				closedBy: 'jakub',
				updatedAt: iso(now - 200 * MINUTE),
				ago: 260,
			},
			now,
		),
	]
}

/** Slack threads for the Slack stories: a DM, a group DM, an @mention and a followed thread. */
export function signalSlackFixtures(now = Date.now()): SignalThread[] {
	const permalink = (channel: string, ts: string) =>
		`https://cntmbr.slack.com/archives/${channel}/p${ts.replace('.', '')}`
	return [
		thread(
			{
				id: 701,
				threadKey: 'slack:T054:D01',
				source: 'slack',
				kind: 'dm',
				ref: 'Klára D.',
				fullRef: 'DM · Klára D.',
				title: 'Můžeš se kouknout na fakturaci u Psyonu dnes?',
				head: 'Klára D.: Můžeš se kouknout na fakturaci u Psyonu dnes?',
				actor: 'Klára D.',
				url: permalink('D01', '1731240000.000100'),
				ago: 6,
			},
			now,
		),
		thread(
			{
				id: 702,
				threadKey: 'slack:T054:G02',
				source: 'slack',
				kind: 'dm',
				ref: 'dev-tým',
				fullRef: 'group DM · dev-tým',
				title: 'Deploy prošel, můžeme mergovat?',
				head: 'Matěj: Deploy prošel, můžeme mergovat?',
				actor: 'Matěj',
				url: permalink('G02', '1731241000.000200'),
				ago: 14,
			},
			now,
		),
		thread(
			{
				id: 703,
				threadKey: 'slack:T054:C03:1731239000.000050',
				source: 'slack',
				kind: 'mention',
				reasons: ['mention'],
				ref: '#general',
				fullRef: 'mention · #general',
				title: 'díky @jakub, můžeš to prosím odsouhlasit?',
				head: 'Petra: díky @jakub, můžeš to prosím odsouhlasit?',
				actor: 'Petra',
				url: permalink('C03', '1731239000.000050'),
				ago: 42,
			},
			now,
		),
		thread(
			{
				id: 704,
				threadKey: 'slack:T054:C04:1731200000.000010',
				source: 'slack',
				kind: 'thread',
				reasons: ['thread'],
				ref: '#clientcare',
				fullRef: 'thread · #clientcare',
				title: 'nová odpověď ve vlákně, kde jsi psal',
				head: 'Ondra: a ještě jedna věc k tomu reportu…',
				actor: 'Ondra',
				url: `${permalink('C04', '1731242000.000300')}?thread_ts=1731200000.000010&cid=C04`,
				ago: 70,
			},
			now,
		),
	]
}

/** One Slack message the rules kept out (a bot), for the filtered list's Slack row. */
export function signalSlackFilteredFixture(now = Date.now()): SignalFilteredEntry {
	return {
		id: 820,
		source: 'slack',
		senderName: 'GitHub',
		senderAddress: 'ub01',
		senderIdentity: 'ub01',
		subject: '[contember/okena] PR #311 merged',
		reason: 'bot',
		mailbox: 'C03',
		url: 'https://cntmbr.slack.com/archives/C03/p1731238000000400',
		receivedAt: iso(now - 90 * MINUTE),
		lastSeenAt: iso(now - 20 * MINUTE),
	}
}

/** The Okena terminals agent asks came from (`$OKENA_TERMINAL_ID`): one idle agent, one working. */
export const ASK_TERMINAL_IDLE = '5d3f8a2e-1c47-4b9e-9a06-3e7b2c8f41d0'
export const ASK_TERMINAL_BUSY = 'c81e4f6a-27b3-4d58-b9e2-6f0a3d7c95b4'

/** Storybook links an ask carries (this checkout's own stories, on the default Storybook port). */
const STORY = 'http://127.0.0.1:6006/?path=/story/'

/**
 * Agent asks (`helm signal add`): a design pick from an idle Okena agent (three links), a yes/no
 * from an agent with no terminal (one link), an approval from a working agent, one already answered.
 */
export function signalAskFixtures(now = Date.now()): SignalThread[] {
	const ask = (seed: Omit<ThreadSeed, 'source' | 'kind' | 'head' | 'fullRef' | 'ref'> & { from?: string }) => {
		const { from = 'agent', ...rest } = seed
		return thread(
			{
				source: 'agent',
				kind: 'ask',
				reasons: ['ask'],
				head: seed.title,
				actor: from,
				fullRef: seed.askTerminal ? `${from} · Okena terminal` : from,
				ref: from,
				...rest,
			},
			now,
		)
	}
	return [
		ask({
			id: 501,
			threadKey: 'agent:signals-asks/row-layout',
			from: 'Signals asks',
			title: 'Agent ask rows: two lines like the others, or a third with the body?',
			body: [
				'Two row variants for asks in Needs you, both in Storybook.',
				'A: two lines, like GitHub and Mail; the link count on the right.',
				"B: a dim third line with the body's first line and the link count.",
			].join('\n'),
			links: [
				`${STORY}views-signals-agent-asks--title-rows`,
				`${STORY}views-signals-agent-asks--body-line`,
				'https://github.com/neumie/helm/pull/412',
			],
			askTerminal: ASK_TERMINAL_IDLE,
			ago: 2,
		}),
		ask({
			id: 502,
			threadKey: 'agent:legacy-vigil-scheme',
			title: 'Drop the legacy vigil:// link handler?',
			body: 'Nothing has opened a vigil:// link since July. Yes or no is enough.',
			links: ['https://github.com/neumie/helm/pull/409'],
			ago: 15,
		}),
		ask({
			id: 503,
			threadKey: 'agent:okena-stream-lease/approve',
			from: 'okena-stream-lease',
			title: 'Approve the 60 s stream lease before I merge?',
			links: ['https://github.com/contember/okena/pull/318'],
			askTerminal: ASK_TERMINAL_BUSY,
			ago: 35,
		}),
		ask({
			id: 504,
			threadKey: 'agent:signals-asks/terminal-name',
			from: 'Signals asks',
			title: 'Name the terminal "Signals asks"?',
			askTerminal: ASK_TERMINAL_IDLE,
			state: 'seen',
			reply: 'Yes',
			replyAt: iso(now - 40 * MINUTE),
			routedAgent: 'signals-agent-asks',
			routedHow: 'replied',
			routedAt: iso(now - 40 * MINUTE),
			ago: 45,
		}),
	]
}

/**
 * The dispatcher's asks as it writes them from now on (`helm signal add --choice`): a one-line summary,
 * then the project, the context, the options and its recommendation; quick answers when a word is
 * enough. 505 asks from the idle Signals terminal (the answer is typed in), 506 is long and from a
 * terminal the dock does not list.
 */
export function signalAskChoiceFixtures(now = Date.now()): SignalThread[] {
	const ask = (seed: Omit<ThreadSeed, 'source' | 'kind' | 'head' | 'fullRef' | 'ref'> & { from?: string }) => {
		const { from = 'dispatcher', ...rest } = seed
		return thread(
			{
				source: 'agent',
				kind: 'ask',
				reasons: ['ask'],
				head: seed.title,
				actor: from,
				fullRef: seed.askTerminal ? `${from} · Okena terminal` : from,
				ref: from,
				...rest,
			},
			now,
		)
	}
	return [
		ask({
			id: 505,
			threadKey: 'agent:dispatcher/zkraceni',
			title: 'Zkrácení: mám zkrátit názvy terminálů na 24 znaků?',
			body: [
				'Zkrácení názvů terminálů v Okeně na 24 znaků, aby se vešly do záložek.',
				'',
				'Projekt: helm (Signals, Okena board)',
				'Kontext: názvy jako "Inventura úpravy skladových karet" se v záložce uříznou uprostřed slova a nejde poznat, co terminál dělá.',
				'',
				'Možnosti:',
				'Ano — zkrátím na 24 znaků po celých slovech, plný název zůstane v tooltipu.',
				'Ne — nechám názvy, jak jsou.',
				'',
				'Doporučuju Ano.',
			].join('\n'),
			choices: ['Ano', 'Ne'],
			links: ['https://github.com/neumie/helm/pull/431', `${STORY}views-signals-detail--ask`],
			askTerminal: ASK_TERMINAL_IDLE,
			ago: 4,
		}),
		ask({
			id: 506,
			threadKey: 'agent:dispatcher/remote-host',
			title: 'Remote: přesunout host na Mac mini, nebo nechat na notebooku?',
			body: [
				'Přesun Helm Remote hostu z notebooku na Mac mini v kanceláři.',
				'',
				'Projekt: helm (Remote)',
				'Kontext: Remote teď běží na notebooku; když ho zavřeš, telefon se nepřipojí.',
				'Mac mini běží pořád, Tailscale na něm je, ale není tam Okena ani tvoje Pi session.',
				'Remote umí jen existující Pi session na stejném stroji, takže by na mini viděl jen to, co tam poběží.',
				'',
				'Možnosti:',
				'1. Nechat na notebooku. Nic se nemění; mimo kancelář jen s otevřeným víkem.',
				'2. Přesunout na mini a pouštět tam agenty přes Okenu na mini.',
				'   Telefon vidí vše, co běží na mini; notebook je pak jen terminál.',
				'3. Dva hosty, každý se svým párováním.',
				'   Funguje hned, ale na telefonu dva odkazy a dvě sady zařízení.',
				'',
				'Rizika:',
				'- Na mini chybí tvoje SSH klíče a gh přihlášení; agent by se nedostal k privátním repům.',
				'- Pi config se nesdílí; nastavení modelu by se muselo udržovat dvakrát.',
				'- Párování se nepřenáší, musel bys spárovat telefon znovu.',
				'',
				'Co bych udělal:',
				'Teď nechat na notebooku (1).',
				'Až budeš chtít agenty přes noc, připravím mini jako druhý host (3) a sepíšu, co tam chybí.',
				'',
				'Nespěchá to; stačí odpověď do pátku.',
			].join('\n'),
			askTerminal: '0f4e9a12-77c1-4d5e-8a3b-9c2d1e6f5a40',
			ago: 5,
		}),
	]
}

/**
 * Agent answers (`helm signal add --kind answer`): informational replies to something Jakub asked an
 * agent in its chat — a longer one from the dispatcher (its detail scrolls), one with a link, one
 * already opened (seen). None takes a reply or a terminal.
 */
export function signalAnswerFixtures(now = Date.now()): SignalThread[] {
	const answer = (seed: Omit<ThreadSeed, 'source' | 'kind' | 'head' | 'fullRef' | 'ref'> & { from?: string }) => {
		const { from = 'dispatcher', ...rest } = seed
		return thread(
			{
				source: 'agent',
				kind: 'answer',
				reasons: ['answer'],
				head: seed.title,
				actor: from,
				fullRef: from,
				ref: from,
				...rest,
			},
			now,
		)
	}
	return [
		answer({
			id: 601,
			threadKey: 'agent:answer/remote-proxy',
			title: 'Proxy blokuje Remote',
			body: [
				'Remote z telefonu nejde, protože firemní proxy na Wi‑Fi v kanceláři blokuje WebSocket na *.ts.net.',
				'Helm Remote i Tailscale běží v pořádku: z LTE se připojíš hned.',
				'Ověřil jsem to přes curl z notebooku za proxy: HTTP 403 od proxy, ne od Remote.',
				'',
				'Možnosti:',
				'1. Na telefonu vypnout Wi‑Fi a jet přes LTE (funguje teď).',
				'2. Požádat správce o výjimku pro *.ts.net (nejčistší).',
				'3. Tailscale exit node doma — zbytečně složité.',
				'',
				'Nic dalšího po tobě nechci; jen ať víš, proč to nešlo.',
			].join('\n'),
			ago: 3,
		}),
		answer({
			id: 602,
			threadKey: 'agent:answer/slack-poll-rate',
			title: 'Jak často Signals čtou Slack?',
			body: 'Každých 60 s (signals.slack.pollSeconds), nejvýš 30 DM a 15 vláken na jedno čtení.\nRate limit Tier 3 je daleko.',
			links: ['https://github.com/neumie/helm/blob/main/AGENTS.md'],
			ago: 26,
		}),
		answer({
			id: 603,
			threadKey: 'agent:answer/okena-304-status',
			from: 'okena-stream-lease',
			title: 'okena#304: druhé kolo review je zapracované',
			body: 'matej21 chtěl kratší lease; je 60 s a CI je zelené.',
			links: ['https://github.com/contember/okena/pull/304'],
			state: 'seen',
			ago: 70,
		}),
	]
}

/** An answer Jakub read and closed today (Done today: `read`). */
export function signalAnswerDoneFixture(now = Date.now()): SignalThread {
	return thread(
		{
			id: 604,
			threadKey: 'agent:answer/build-id',
			source: 'agent',
			kind: 'answer',
			reasons: ['answer'],
			ref: 'dispatcher',
			fullRef: 'dispatcher',
			title: 'Proč se daemon po buildu restartoval?',
			head: 'Proč se daemon po buildu restartoval?',
			actor: 'dispatcher',
			body: 'Build ID se změnil (dirty checkout), takže ho Helm restartoval sám; běh nic neběželo.',
			state: 'done',
			closedBy: 'jakub',
			updatedAt: iso(now - 12 * MINUTE),
			ago: 50,
		},
		now,
	)
}

/**
 * More threads done today, one per way a thread gets done (with okena#298 gone from GitHub and
 * crane-rental#965 dismissed in {@link signalThreadFixtures}): mail read in Mail (also a Sentry
 * alert), a managed mail closed by its agent with a note, a PR an agent closed, an answered ask the
 * agent closed (two links: `o` lists them from the Done today list), and one closed by hand before
 * the daemon recorded who.
 */
export function signalDoneFixtures(now = Date.now()): SignalThread[] {
	const done = (seed: ThreadSeed & { closedMinutesAgo: number }): SignalThread => {
		const { closedMinutesAgo, ...rest } = seed
		return thread({ state: 'done', ...rest, updatedAt: iso(now - closedMinutesAgo * MINUTE) }, now)
	}
	return [
		done({
			id: 46,
			threadKey: 'mail:3c9e7a10b4d25f68',
			source: 'mail',
			kind: 'mail',
			ref: 'Psyon',
			fullRef: 'Klára D. <klara@psyon.example>',
			title: 'Faktura za říjen',
			head: 'Faktura za říjen',
			actor: 'Klára D.',
			url: 'message://%3Cfaktura-rijen%40psyon.example%3E',
			active: false,
			closedReason: 'no longer unread in the inbox or Clientcare',
			ago: 210,
			closedMinutesAgo: 25,
		}),
		done({
			id: 47,
			threadKey: 'sentry:PSYON-ADMIN-3E9',
			source: 'mail',
			kind: 'sentry',
			ref: 'PSYON-ADMIN-3E9',
			fullRef: 'Sentry <alerts@sentry.io>',
			title: 'RangeError: Invalid time value',
			head: 'RangeError: Invalid time value',
			actor: 'Sentry',
			url: 'message://%3Calert-3e9%40sentry.io%3E',
			active: false,
			closedReason: 'no longer unread in the inbox or Clientcare',
			ago: 400,
			closedMinutesAgo: 70,
		}),
		done({
			id: 48,
			threadKey: 'mail:0b8d64e2f9a17c33',
			source: 'mail',
			kind: 'mail',
			ref: 'JVS',
			fullRef: 'Pavel Š. <pavel@jvs.example>',
			title: 'Re: Faktura 2026-118',
			head: 'Re: Faktura 2026-118 · 2 messages',
			actor: 'Pavel Š.',
			url: 'message://%3Cfaktura-118%40jvs.example%3E',
			owner: 'managed',
			managedBy: 'invoice-resend',
			closedBy: 'agent',
			note: 'invoice resent, reply drafted in Mail',
			noteAt: iso(now - 95 * MINUTE),
			ago: 320,
			closedMinutesAgo: 95,
		}),
		done({
			id: 293,
			threadKey: 'github:contember/okena#293',
			source: 'github',
			kind: 'ci',
			ref: 'okena#293',
			fullRef: 'contember/okena#293',
			title: 'Hub socket permissions',
			head: 'CI failing · build',
			url: 'https://github.com/contember/okena/pull/293',
			repo: 'contember/okena',
			number: 293,
			closedBy: 'agent',
			note: 'Merged',
			noteAt: iso(now - 160 * MINUTE),
			ago: 380,
			closedMinutesAgo: 160,
		}),
		done({
			id: 505,
			threadKey: 'agent:signals-asks/foot-line',
			source: 'agent',
			kind: 'ask',
			reasons: ['ask'],
			ref: 'Signals asks',
			fullRef: 'Signals asks · Okena terminal',
			title: 'Filtered count in the footer or the header?',
			head: 'Filtered count in the footer or the header?',
			actor: 'Signals asks',
			links: ['https://github.com/neumie/helm/pull/402', 'https://github.com/neumie/helm/pull/403'],
			askTerminal: ASK_TERMINAL_IDLE,
			reply: 'Footer',
			replyAt: iso(now - 230 * MINUTE),
			routedAgent: 'signals-agent-asks',
			routedHow: 'replied',
			routedAt: iso(now - 230 * MINUTE),
			closedReason: 'closed by the agent',
			closedBy: 'agent',
			note: 'Built the footer line',
			noteAt: iso(now - 215 * MINUTE),
			ago: 240,
			closedMinutesAgo: 215,
		}),
		done({
			id: 49,
			threadKey: 'mail:5aa0c3e19f7d2b04',
			source: 'mail',
			kind: 'mail',
			ref: 'Hetzner',
			fullRef: 'Hetzner Online <noreply@hetzner.example>',
			title: 'Faktura č. R0021934711',
			head: 'Faktura č. R0021934711',
			actor: 'Hetzner Online',
			url: 'message://%3Cfaktura-r0021934711%40hetzner.example%3E',
			ago: 600,
			closedMinutesAgo: 300,
		}),
	]
}

export function signalSourcesFixture(
	now = Date.now(),
	mail: SignalSourceHealth['status'] = 'ok',
): SignalSourceHealth[] {
	return [
		{ source: 'github', status: 'ok', detail: null, lastPollAt: iso(now - MINUTE), lastOkAt: iso(now - MINUTE) },
		{
			source: 'mail',
			status: mail,
			detail:
				mail === 'needs_permission'
					? 'Allow node to control Mail in System Settings › Privacy & Security › Automation'
					: null,
			lastPollAt: iso(now - MINUTE),
			lastOkAt: mail === 'ok' ? iso(now - MINUTE) : null,
		},
	]
}

function session(
	partial: Partial<DockSession> & Pick<DockSession, 'terminalId' | 'project' | 'name' | 'status'>,
	now: number,
): DockSession {
	return {
		key: `okena-default:${partial.terminalId}`,
		source: 'okena',
		profile: 'okena-default',
		since: now - 4 * MINUTE,
		observedAt: now,
		subagents: 0,
		backgroundTasks: 0,
		backgroundShells: 0,
		queuedPrompts: 0,
		prLinks: [],
		hasTranscript: true,
		hooksAttached: true,
		channelAttached: false,
		sessionId: `session-${partial.terminalId}`,
		lastMessage: { uuid: `message-${partial.terminalId}`, text: 'Done.', at: now - 4 * MINUTE, seen: true },
		...partial,
	}
}

/** The agents asks came from: `Signals asks` idle (a reply is typed in), `okena-stream-lease` working. */
export function signalsAskSessions(now = Date.now()): DockSession[] {
	return [
		session(
			{
				terminalId: ASK_TERMINAL_IDLE,
				project: 'helm',
				repo: 'helm',
				name: 'Signals asks',
				branch: 'feat/signals-agent-asks',
				status: 'idle',
				lastMessage: {
					uuid: 'message-signals-asks',
					text: 'Both row variants are in Storybook; the ask is in Signals.',
					at: now - 2 * MINUTE,
					seen: true,
				},
			},
			now,
		),
		session(
			{
				terminalId: ASK_TERMINAL_BUSY,
				project: 'okena',
				repo: 'okena',
				name: 'okena-stream-lease',
				branch: 'feat/okena-stream-lease',
				status: 'working',
			},
			now,
		),
	]
}

/** Agents the dock sees: the PR's own agent (idle), a busy one in the same repo, others. */
export function signalsDockFixture(now = Date.now()): AgentDockSnapshot {
	const health = { state: 'ok' as const, since: now - 60 * MINUTE, lastObservedAt: now }
	return {
		generatedAt: now,
		source: health,
		sources: { okena: health },
		items: [],
		sessions: [
			session(
				{
					terminalId: 't-offer',
					project: 'offer-pdf-export',
					repo: 'crane-rental',
					name: 'offer-pdf-export',
					branch: 'feat/offer-pdf-export',
					status: 'idle',
					prLinks: [
						{
							number: 970,
							url: 'https://github.com/contember-external/crane-rental/pull/970',
							repository: 'contember-external/crane-rental',
						},
					],
				},
				now,
			),
			session(
				{
					terminalId: 't-calendar',
					project: 'rental-calendar-sync',
					repo: 'crane-rental',
					name: 'rental-calendar-sync',
					branch: 'feat/rental-calendar-sync',
					status: 'working',
				},
				now,
			),
			session(
				{
					terminalId: 't-dialog',
					project: 'claude-dialog-answered-in-terminal',
					repo: 'okena',
					name: 'claude-dialog-answered-in-terminal',
					branch: 'fix/claude-dialog-answered-in-terminal',
					status: 'working',
					prLinks: [{ number: 304, url: 'https://github.com/contember/okena/pull/304', repository: 'contember/okena' }],
				},
				now,
			),
			session({ terminalId: 't-okena', project: 'okena', name: 'okena', branch: 'main', status: 'idle' }, now),
			session(
				{
					terminalId: 't-pricelist',
					project: 'pricelist-import',
					repo: 'jvs-eshop',
					name: 'pricelist-import',
					branch: 'feat/pricelist-import',
					status: 'idle',
				},
				now,
			),
			session(
				{
					terminalId: 't-reservations',
					project: 'reservations-export',
					repo: 'psyon-admin',
					name: 'reservations-export',
					branch: 'fix/reservations-export',
					status: 'idle',
				},
				now,
			),
		],
	}
}

/** Mail the rules kept out (heads only), newest first. Senders are illustrative. */
export function signalFilteredFixtures(now = Date.now()): SignalFilteredEntry[] {
	const entry = (
		id: number,
		ago: number,
		seed: Pick<SignalFilteredEntry, 'senderName' | 'senderAddress' | 'subject' | 'reason'> &
			Partial<SignalFilteredEntry>,
	): SignalFilteredEntry => ({
		source: 'mail',
		senderIdentity: seed.senderAddress,
		mailbox: null,
		url: `message://%3Cfiltered-${id}%40mail.example%3E`,
		receivedAt: iso(now - ago * MINUTE),
		lastSeenAt: iso(now - MINUTE),
		id,
		...seed,
	})
	return [
		entry(8, 12, {
			senderName: 'Petra Nováková',
			senderAddress: 'petra@psyon.example',
			subject: 'Re: Dovolená do 14. 11.',
			reason: 'auto-reply',
		}),
		entry(7, 40, {
			senderName: 'Contember',
			senderAddress: 'news@contember.example',
			subject: 'What shipped in October',
			reason: 'newsletter',
		}),
		entry(6, 95, {
			senderName: 'Fakturoid',
			senderAddress: 'info@fakturoid.example',
			subject: 'Nové funkce pro listopad',
			reason: 'campaign',
			mailbox: 'Clientcare',
		}),
		entry(5, 180, {
			senderName: '',
			senderAddress: 'deals@shop.example',
			subject: 'Last chance: 40 % off',
			reason: 'junk',
		}),
		entry(4, 600, {
			senderName: 'Build bot',
			senderAddress: 'ci@builds.example',
			subject: 'Nightly build finished',
			reason: 'excluded',
		}),
	]
}

export const OKENA_PROJECTS_FIXTURE: SignalOkenaProject[] = [
	{ id: 'p-crane', name: 'crane-rental', repo: 'contember-external/crane-rental' },
	{ id: 'p-okena', name: 'okena', repo: 'contember/okena' },
	{ id: 'p-psyon', name: 'psyon-admin', repo: 'psyon/psyon-admin' },
	{ id: 'p-jvs', name: 'jvs-eshop', repo: null },
]

/** Every effect a story's column asked for (browser tests read them from `window.__signalsFixture`). */
export interface SignalsFixtureCalls {
	updates: Array<{ id: number; patch: SignalUpdate }>
	routed: Array<{ id: number; agent: string; how: string }>
	opened: string[]
	/** Answers saved on agent asks (`service.reply`). */
	replies: Array<{ id: number; text: string }>
	/** Ask links opened (`service.openLink`): position, the link the column showed, the link the fake resolved. */
	openedLinks: Array<{ id: number; index: number; shown: string; url: string | null }>
	prompts: AgentDockPromptRequest[]
	/** Dock item answers (`dock.act`): an ask's reply to its agent's open turn item. */
	acts: AgentDockActRequest[]
	okenaProjects: Array<string | null>
	newAgents: SignalNewAgentRequest[]
	/** Filtered-mail ids `i` asked to always show (or unmute). */
	includes: number[]
	/** Mail thread ids `x` muted the sender of. */
	mutes: number[]
}

/** The routing effects a browser test can hold in flight (`newAgent`: the Okena start, `prompt`: the dock send, prompt or act). */
export type SignalsHeldEffect = 'newAgent' | 'prompt'

/**
 * Outcomes a browser test scripts for the next calls (each applies until replaced): the dock's
 * `prompt` and `act` (default `sent`; a `queue` prompt to a working agent `queued`), and
 * `service.routed` failing with this error (default it saves).
 */
export interface SignalsFixtureScript {
	prompt?: DockActOutcome
	act?: DockActOutcome
	routedError?: string
}

export interface SignalsFixture {
	service: SignalsService
	dock: DockService
	calls: SignalsFixtureCalls
	/** Browser tests only: scripts the outcomes of later calls (merged into the current script). */
	script(next: SignalsFixtureScript): void
	/**
	 * Browser tests only: the dock opens a turn item (`state` default `open`) for the session in this
	 * Okena terminal, as it does TURN_IDLE_MS after an agent stops, and pushes. Returns its item id.
	 */
	openTurn(terminalId: string, state?: DockItem['state']): number
	/** Browser tests only: later calls of this effect wait (recorded at once) until `release`. */
	hold(effect: SignalsHeldEffect): void
	/** Lets every waiting call of this effect finish, and stops holding it. */
	release(effect: SignalsHeldEffect): void
	/**
	 * Browser tests only: a prompt lands in the transcript of this Okena terminal, typed by Jakub
	 * (or by Helm, when it is what the dock just sent). Runs main's real SignalsAskResolver, which
	 * closes the open asks bound to that terminal through the fake daemon's `answered` route.
	 */
	terminalPrompt(terminalId: string, text: string): Promise<void>
}

export interface SignalsFixtureOptions {
	threads?: SignalThread[]
	sources?: SignalSourceHealth[]
	/** null: the agent dock has not pushed a snapshot (no agent listed). */
	dock?: AgentDockSnapshot | null
	now?: () => number
	/** Mail the rules kept out; default `signalFilteredFixtures`, `[]` for none. */
	filtered?: SignalFilteredEntry[]
}

/** A fixture mail thread's sender address, from its `Name <address>` full ref (the daemon stores it apart). */
function senderOf(thread: SignalThread): string | null {
	const match = /<([^<>\s]+@[^<>\s]+)>\s*$/.exec(thread.fullRef)
	return match?.[1]?.toLowerCase() ?? null
}

/**
 * In-memory column services: updates apply like the daemon's store (state/owner/snooze rules, routed
 * receipts) and push a new snapshot, as main does after a re-read.
 */
export function createSignalsFixture(options: SignalsFixtureOptions = {}): SignalsFixture {
	const clock = options.now ?? Date.now
	const start = clock()
	let threads = (options.threads ?? signalThreadFixtures(start)).map(entry => ({ ...entry }))
	const sources = options.sources ?? signalSourcesFixture(start)
	let filtered = (options.filtered ?? signalFilteredFixtures(start)).map(entry => ({ ...entry }))
	const included: string[] = []
	/** Muted senders and the threads muting closed (`x`); `i` on their filtered mail reopens them. */
	const muted = new Map<string, number[]>()
	let nextFiltered = 100
	let seq = 1
	const listeners = new Set<() => void>()
	const snapshotOf = (): SignalsSnapshot => ({
		threads,
		sources,
		seq,
		generatedAt: iso(clock()),
		filteredCount: filtered.length,
	})
	let state: SignalsBridgeState = { snapshot: snapshotOf(), error: null, at: start }
	const publish = (): void => {
		seq += 1
		state = { snapshot: snapshotOf(), error: null, at: clock() }
		for (const listener of listeners) listener()
	}
	const calls: SignalsFixtureCalls = {
		updates: [],
		routed: [],
		opened: [],
		replies: [],
		openedLinks: [],
		prompts: [],
		acts: [],
		okenaProjects: [],
		newAgents: [],
		includes: [],
		mutes: [],
	}
	const held = new Map<SignalsHeldEffect, { wait: Promise<void>; release(): void }>()
	const hold = (effect: SignalsHeldEffect): void => {
		if (held.has(effect)) return
		let release = (): void => undefined
		const wait = new Promise<void>(resolve => {
			release = resolve
		})
		held.set(effect, { wait, release })
	}
	const release = (effect: SignalsHeldEffect): void => {
		held.get(effect)?.release()
		held.delete(effect)
	}
	const gate = async (effect: SignalsHeldEffect): Promise<void> => {
		await held.get(effect)?.wait
	}
	const change = (id: number, apply: (entry: SignalThread, at: string) => SignalThread) => {
		const current = threads.find(entry => entry.id === id)
		if (!current) return { error: 'Signal not found', status: 404 } as const
		// Strictly newer than anything the column holds, even within one millisecond.
		const at = iso(Math.max(clock(), Date.parse(current.updatedAt) + 1))
		const next = apply(current, at)
		threads = threads.map(entry => (entry.id === id ? next : entry))
		publish()
		return { data: next } as const
	}
	// Main's ask resolver against this fake daemon: GET the open asks, POST /signals/:id/answered.
	let promptSeq = 0
	const resolver = new SignalsAskResolver({
		now: clock,
		timers: { setTimeout: () => 0, clearTimeout: () => undefined },
		request: async <T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<HelmResult<T>> => {
			if (method === 'GET') return { data: snapshotOf() as T }
			const match = /^\/signals\/(\d+)\/answered$/.exec(path)
			const input = body as { activityAt: string; promptAt: string }
			if (!match) return { error: 'not found', status: 404 }
			const id = Number(match[1])
			const current = threads.find(entry => entry.id === id)
			if (!current) return { error: 'Signal not found', status: 404 }
			if (current.lastActivityAt !== input.activityAt) return { error: 'The ask changed', status: 409 }
			const changed = change(id, (entry, at) => ({
				...entry,
				state: 'done',
				snoozedUntil: null,
				closedReason: 'answered in the terminal',
				closedBy: 'jakub',
				updatedAt: at,
			}))
			return changed as HelmResult<T>
		},
	})
	resolver.start()
	const terminalPrompt = async (terminalId: string, text: string): Promise<void> => {
		await resolver.refresh()
		promptSeq += 1
		resolver.observePrompts(terminalId, [
			{ uuid: `fixture-prompt-${promptSeq}`, timestamp: iso(clock()), text, origin: 'terminal' },
		])
		await resolver.refresh()
	}
	const service: SignalsService = {
		getState: () => state,
		subscribe(listener) {
			listeners.add(listener)
			return () => listeners.delete(listener)
		},
		async update(id, patch) {
			calls.updates.push({ id, patch })
			return change(id, (entry, at) => ({
				...entry,
				...(patch.owner ? { owner: patch.owner } : {}),
				...(patch.managedBy !== undefined ? { managedBy: patch.managedBy } : {}),
				...(patch.state
					? {
							state: patch.state,
							snoozedUntil: patch.state === 'snoozed' ? (patch.snoozedUntil ?? null) : null,
							closedReason: null,
							// As the daemon: a close through Helm (its control token) is Jakub's.
							closedBy: patch.state === 'done' ? ('jakub' as const) : null,
						}
					: {}),
				updatedAt: at,
			}))
		},
		async routed(id, body) {
			calls.routed.push({ id, ...body })
			if (scripted.routedError !== undefined) return { error: scripted.routedError }
			return change(id, (entry, at) => ({
				...entry,
				routedAgent: body.agent,
				routedHow: body.how,
				routedAt: at,
				state: entry.state === 'new' ? 'seen' : entry.state,
				updatedAt: at,
			}))
		},
		async open(url) {
			calls.opened.push(url)
			return { data: true }
		},
		async filtered() {
			// As the daemon: an `excluded` entry whose sender only a mute keeps out says so (`i` unmutes it).
			const entries = filtered.map(entry =>
				entry.reason === 'excluded' && muted.has(entry.senderIdentity)
					? { ...entry, unmute: true as const }
					: { ...entry },
			)
			return { data: { entries, total: filtered.length, retentionDays: 7 } }
		},
		async include(id) {
			calls.includes.push(id)
			const entry = filtered.find(item => item.id === id)
			if (!entry) return { error: 'Filtered mail not found', status: 404 }
			const address = entry.senderIdentity
			// As the daemon: the sender's rows leave the log, and the next poll keeps their mail.
			filtered = filtered.filter(item => item.senderIdentity !== address)
			const reopen = muted.get(address)
			if (entry.reason === 'excluded' && muted.has(address)) {
				// Unmuted: off the exclude list, never onto the include list; the poll reopens its threads.
				muted.delete(address)
				const at = iso(clock())
				threads = threads.map(item =>
					reopen?.includes(item.id)
						? { ...item, state: 'seen', active: true, closedReason: null, closedBy: null, updatedAt: at }
						: item,
				)
				publish()
				return { data: { address, added: false, unmuted: true } }
			}
			const added = !included.includes(address)
			if (added) included.push(address)
			publish()
			return { data: { address, added } }
		},
		async mute(id) {
			calls.mutes.push(id)
			const target = threads.find(entry => entry.id === id)
			if (!target) return { error: 'Signal not found', status: 404 }
			if (target.source !== 'mail' || target.kind !== 'mail')
				return {
					error: target.kind === 'sentry' ? 'Sentry alerts always show' : 'Only mail senders can be muted',
					status: 400,
				}
			if (target.owner !== 'jakub')
				return { error: 'An agent is handling this thread; take it back first', status: 409 }
			const address = senderOf(target)
			if (!address) return { error: 'The sender is not known yet; try again after the next Mail poll', status: 409 }
			// As the daemon's store: Jakub's open mail threads from the sender close, their mail is filtered.
			const closing = threads.filter(
				entry =>
					entry.source === 'mail' &&
					entry.kind === 'mail' &&
					entry.owner === 'jakub' &&
					entry.state !== 'done' &&
					senderOf(entry) === address,
			)
			const at = iso(clock())
			const ids = closing.map(entry => entry.id)
			threads = threads.map(entry =>
				ids.includes(entry.id)
					? {
							...entry,
							state: 'done',
							snoozedUntil: null,
							active: false,
							closedReason: 'sender muted',
							closedBy: 'jakub',
							updatedAt: at,
						}
					: entry,
			)
			const listed = closing.map(
				(entry): SignalFilteredEntry => ({
					id: ++nextFiltered,
					source: 'mail',
					senderName: entry.actor ?? '',
					senderAddress: address,
					senderIdentity: address,
					subject: entry.title,
					reason: 'excluded',
					mailbox: null,
					url: entry.url,
					receivedAt: entry.lastActivityAt,
					lastSeenAt: at,
				}),
			)
			filtered = [...listed, ...filtered].sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt))
			muted.set(address, [...(muted.get(address) ?? []), ...ids])
			const unincluded = included.includes(address)
			if (unincluded) included.splice(included.indexOf(address), 1)
			publish()
			return { data: { address, added: true, unincluded, threadIds: ids } }
		},
		async okenaProjects(repo) {
			calls.okenaProjects.push(repo)
			const matches = repo
				? OKENA_PROJECTS_FIXTURE.filter(project => project.repo?.toLowerCase() === repo.toLowerCase())
				: []
			return {
				data: { projects: OKENA_PROJECTS_FIXTURE, suggested: matches.length === 1 ? (matches[0]?.id ?? null) : null },
			}
		},
		async newAgent(request) {
			calls.newAgents.push(request)
			await gate('newAgent')
			return { data: { terminalId: 't-new', sessionId: 'session-new', agentName: request.branch } }
		},
		async reply(id, body) {
			calls.replies.push({ id, text: body.text })
			const target = threads.find(entry => entry.id === id)
			if (target && target.source !== 'agent') return { error: 'Only agent asks take a reply', status: 400 }
			return change(id, (entry, at) => ({
				...entry,
				reply: body.text.trim(),
				replyAt: at,
				state: entry.state === 'new' ? 'seen' : entry.state,
				updatedAt: at,
			}))
		},
		async openLink(id, index, shown) {
			// Like main: the link comes from the thread as stored, never from the renderer, and opens
			// only while it is still the one shown.
			const target = threads.find(entry => entry.id === id)
			const url = target?.source === 'agent' ? (target.links[index] ?? null) : null
			calls.openedLinks.push({ id, index, shown, url })
			if (!url) return { error: 'That link does not exist.', status: 404 }
			return url === shown ? { data: true } : { error: 'The links changed; look at the ask again.', status: 409 }
		},
		async slackReply(id, body) {
			calls.replies.push({ id, text: body.text })
			const target = threads.find(entry => entry.id === id)
			if (target && target.source !== 'slack')
				return { error: 'Only Slack threads can be replied to here', status: 400 }
			return change(id, (entry, at) => ({ ...entry, state: 'done', closedReason: 'answered in Slack', updatedAt: at }))
		},
		async slackMute(id) {
			return { data: { userId: 'u', added: true, unincluded: false, threadIds: [id] } }
		},
		async slackInclude(_id) {
			return { data: { userId: 'u', added: true, unmuted: true } }
		},
	}
	let dockSnapshot = options.dock === undefined ? signalsDockFixture(start) : options.dock
	const dockListeners = new Set<() => void>()
	let scripted: SignalsFixtureScript = {}
	let nextItem = 900
	const sent: DockActOutcome = { status: 'sent', delivery: 'pty' }
	const result = (outcome: DockActOutcome) => ({ ok: outcome.status === 'sent', outcome }) as const
	const dock: DockService = {
		snapshot: () => dockSnapshot,
		subscribe(listener) {
			dockListeners.add(listener)
			return () => dockListeners.delete(listener)
		},
		async prompt(request) {
			calls.prompts.push(request)
			const target = dockSnapshot?.sessions.find(entry => entry.key === request.session)
			if (target) resolver.promptSending({ source: target.source, terminalId: target.terminalId }, request.text)
			await gate('prompt')
			// As Okena: a new prompt to a working agent is held until its turn ends.
			const working =
				request.queue === true &&
				dockSnapshot?.sessions.find(entry => entry.key === request.session)?.status === 'working'
			return result(scripted.prompt ?? (working ? { status: 'sent', delivery: 'queued' } : sent))
		},
		async act(request) {
			calls.acts.push(request)
			const item = dockSnapshot?.items.find(entry => entry.id === request.itemId)
			const target = dockSnapshot?.sessions.find(entry => entry.key === item?.session)
			if (target && request.action.type === 'prompt')
				resolver.promptSending({ source: target.source, terminalId: target.terminalId }, request.action.text)
			await gate('prompt')
			return result(scripted.act ?? sent)
		},
	}
	const script = (next: SignalsFixtureScript): void => {
		scripted = { ...scripted, ...next }
	}
	const openTurn = (terminalId: string, state: DockItem['state'] = 'open'): number => {
		const snap = dockSnapshot
		const session = snap?.sessions.find(entry => entry.terminalId === terminalId)
		if (!snap || !session) throw new Error(`No dock session in terminal ${terminalId}`)
		nextItem += 1
		const at = clock()
		const uuid = session.lastMessage?.uuid ?? `message-${terminalId}`
		const item: DockItem = {
			id: nextItem,
			key: `turn:${session.sessionId ?? session.key}:${uuid}`,
			kind: 'turn',
			session: session.key,
			openedAt: at,
			fact: {
				kind: 'turn',
				...(session.sessionId ? { sessionId: session.sessionId } : {}),
				assistantUuid: uuid,
				text: session.lastMessage?.text ?? 'Done.',
				endedAt: at - 3_000,
				hadBackground: false,
			},
			state,
		}
		dockSnapshot = { ...snap, generatedAt: at, items: [...snap.items, item] }
		for (const listener of dockListeners) listener()
		return item.id
	}
	return { service, dock, calls, hold, release, script, openTurn, terminalPrompt }
}
