// One page for every open design decision: question, the real variants (each story in its own iframe, so one
// variant's token overrides on <html> never leak into another), and a pick. Picks stay in this browser's
// localStorage and leave as text Jakub pastes into the chat. Storybook-only; nothing in production imports it.
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react'
import { Btn } from '../../button'
import { DECISIONS, type DecisionGroup, type Question, questionKey } from './decisions'

const PICKS_KEY = 'helm.proposals.picks.v1'
const RECOMMENDED = /\s*\(doporučuji\)\s*/
const DEFAULT_HEIGHT = 640

interface Variant {
	/** Story id, or the text option's code. Stored as the pick. */
	value: string
	/** Short code before " · ", e.g. "A2" or "Current". */
	code: string
	label: string
	recommended: boolean
	detail?: string
}

type IndexState = { status: 'loading' } | { status: 'ready'; byTitle: Map<string, Variant[]> } | { status: 'error' }

interface IndexEntry {
	type?: string
	id: string
	title: string
	name: string
}

function useProposalIndex(): IndexState {
	const [state, setState] = useState<IndexState>({ status: 'loading' })
	useEffect(() => {
		let live = true
		fetch(new URL('index.json', window.location.href))
			.then(response => (response.ok ? response.json() : Promise.reject(new Error(String(response.status)))))
			.then((json: { entries: Record<string, IndexEntry> }) => {
				const byTitle = new Map<string, Variant[]>()
				for (const entry of Object.values(json.entries)) {
					if (entry.type !== undefined && entry.type !== 'story') continue
					if (!entry.title.startsWith('Proposals/')) continue
					const label = entry.name.replace(RECOMMENDED, ' ').trim()
					const variants = byTitle.get(entry.title) ?? []
					variants.push({
						value: entry.id,
						code: label.split(' · ')[0] ?? label,
						label,
						recommended: RECOMMENDED.test(entry.name),
					})
					byTitle.set(entry.title, variants)
				}
				if (live) setState({ status: 'ready', byTitle })
			})
			.catch(() => {
				if (live) setState({ status: 'error' })
			})
		return () => {
			live = false
		}
	}, [])
	return state
}

type Picks = Readonly<Record<string, string>>

function readPicks(): Picks {
	try {
		const raw = window.localStorage.getItem(PICKS_KEY)
		const parsed: unknown = raw === null ? {} : JSON.parse(raw)
		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
		return Object.fromEntries(Object.entries(parsed).filter(([, value]) => typeof value === 'string'))
	} catch {
		return {}
	}
}

function usePicks(): [Picks, (next: Picks) => void] {
	const [picks, setPicks] = useState<Picks>(readPicks)
	const save = (next: Picks) => {
		setPicks(next)
		try {
			window.localStorage.setItem(PICKS_KEY, JSON.stringify(next))
		} catch {
			// Private mode or a full quota: the picks still live for this page view and in the copied text.
		}
	}
	return [picks, save]
}

function variantsOf(question: Question, index: IndexState): Variant[] {
	if (question.kind === 'text')
		return question.options.map(option => ({
			value: option.code,
			code: option.code,
			label: option.label,
			recommended: option.recommended === true,
			detail: option.detail,
		}))
	return index.status === 'ready' ? (index.byTitle.get(question.title) ?? []) : []
}

const anchorId = (decision: string) => `decide-${decision.toLowerCase()}`

export function AllDecisions() {
	const index = useProposalIndex()
	const [picks, setPicks] = usePicks()
	const [copied, setCopied] = useState<'idle' | 'copied' | 'manual'>('idle')
	const [confirmClear, setConfirmClear] = useState(false)
	const textRef = useRef<HTMLTextAreaElement>(null)

	const questions = useMemo(
		() => DECISIONS.flatMap(group => group.questions.map(question => ({ group, question }))),
		[],
	)
	const variantsByKey = useMemo(
		() => new Map(questions.map(({ question }) => [questionKey(question), variantsOf(question, index)])),
		[questions, index],
	)
	const pickOf = (question: Question): Variant | undefined => {
		const value = picks[questionKey(question)]
		return variantsByKey.get(questionKey(question))?.find(variant => variant.value === value)
	}
	const decided = questions.filter(({ question }) => pickOf(question) !== undefined).length

	const summary = useMemo(() => {
		const lines = ['Volby design systému (Storybook → Proposals/All decisions):']
		const open: string[] = []
		for (const { question } of questions) {
			const value = picks[questionKey(question)]
			const variant = variantsByKey.get(questionKey(question))?.find(candidate => candidate.value === value)
			if (variant === undefined) open.push(`${question.decision} ${question.topic}`)
			else lines.push(`${question.decision} ${question.topic}: ${variant.label}`)
		}
		if (open.length > 0) lines.push(`Nerozhodnuto: ${open.join(', ')}`)
		return lines.join('\n')
	}, [questions, picks, variantsByKey])

	const pick = (question: Question, value: string | undefined) => {
		const next: Record<string, string> = { ...picks }
		if (value === undefined) delete next[questionKey(question)]
		else next[questionKey(question)] = value
		setPicks(next)
		setCopied('idle')
	}

	const fillRecommended = () => {
		const next: Record<string, string> = { ...picks }
		for (const { question } of questions) {
			const key = questionKey(question)
			if (pickOf(question) !== undefined) continue
			const recommended = variantsByKey.get(key)?.find(variant => variant.recommended)
			if (recommended !== undefined) next[key] = recommended.value
		}
		setPicks(next)
		setCopied('idle')
	}

	const copy = async () => {
		try {
			await navigator.clipboard.writeText(summary)
			setCopied('copied')
		} catch {
			textRef.current?.focus()
			textRef.current?.select()
			setCopied('manual')
		}
	}

	const groupDone = (group: DecisionGroup) => group.questions.every(question => pickOf(question) !== undefined)

	return (
		<div className="decide">
			<header className="decide-bar">
				<div className="decide-inner">
					<div className="decide-bar-row">
						<h1 className="decide-title">Rozhodnutí design systému</h1>
						<span className="decide-progress">
							Rozhodnuto {decided} z {questions.length}
						</span>
						<span className="decide-bar-actions">
							<Btn sm onClick={fillRecommended}>
								Doplnit doporučené
							</Btn>
							{confirmClear ? (
								<Btn
									sm
									tone="danger"
									onClick={() => {
										setPicks({})
										setConfirmClear(false)
										setCopied('idle')
									}}
								>
									Opravdu smazat volby
								</Btn>
							) : (
								<Btn sm tone="ghost" onClick={() => setConfirmClear(true)}>
									Začít znovu
								</Btn>
							)}
							<Btn sm tone="primary" onClick={() => void copy()}>
								Zkopírovat volby
							</Btn>
						</span>
					</div>
					<nav className="decide-nav" aria-label="Rozhodnutí">
						{DECISIONS.map(group => (
							<a key={group.decision} href={`#${anchorId(group.decision)}`} data-done={groupDone(group) || undefined}>
								{groupDone(group) ? '✓ ' : ''}
								{group.decision}
							</a>
						))}
					</nav>
					{copied === 'copied' ? (
						<output className="decide-status">Zkopírováno. Vlož to do chatu.</output>
					) : copied === 'manual' ? (
						<output className="decide-status">Schránka nejde. Text dole je označený, zkopíruj ho ⌘C.</output>
					) : null}
				</div>
			</header>
			<main className="decide-inner">
				<p className="decide-how">
					U každé otázky klikni na variantu, kterou chceš vidět, a tlačítkem pod náhledem ji vyber. „Current“ znamená
					nechat, jak to je. Volby se pamatují v tomhle prohlížeči. Až budeš hotový, dej Zkopírovat volby a vlož je do
					chatu.
				</p>
				{index.status === 'error' ? (
					<p className="decide-status" role="alert">
						Nepovedlo se načíst seznam stories (index.json). Obnov stránku.
					</p>
				) : null}

				{DECISIONS.map(group => (
					<section key={group.decision} className="decide-group" id={anchorId(group.decision)}>
						<h2 className="decide-group-title">
							<span className="decide-id">{group.decision}</span> {group.name}
						</h2>
						{group.intro === undefined ? null : <p className="decide-intro">{group.intro}</p>}
						{group.questions.map(question => (
							<QuestionCard
								key={questionKey(question)}
								question={question}
								variants={variantsByKey.get(questionKey(question)) ?? []}
								loading={question.kind === 'stories' && index.status === 'loading'}
								picked={pickOf(question)}
								onPick={value => pick(question, value)}
								multi={group.questions.length > 1}
							/>
						))}
					</section>
				))}

				<section className="decide-group">
					<h2 className="decide-group-title">Volby jako text</h2>
					<textarea ref={textRef} className="decide-text" readOnly value={summary} rows={12} />
				</section>
			</main>
		</div>
	)
}

function QuestionCard({
	question,
	variants,
	loading,
	picked,
	onPick,
	multi,
}: {
	question: Question
	variants: readonly Variant[]
	loading: boolean
	picked: Variant | undefined
	onPick: (value: string | undefined) => void
	multi: boolean
}) {
	const [shown, setShown] = useState<string | undefined>(undefined)
	const current = variants.find(variant => variant.value === (shown ?? picked?.value)) ?? variants[0]
	const tabs = useRef<(HTMLButtonElement | null)[]>([])

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (current === undefined) return
		const at = variants.indexOf(current)
		const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
		if (step === 0) return
		event.preventDefault()
		const next = variants[(at + step + variants.length) % variants.length]
		if (next === undefined) return
		setShown(next.value)
		tabs.current[variants.indexOf(next)]?.focus()
	}

	return (
		<article className="decide-card">
			<header className="decide-card-head">
				{multi ? <h3 className="decide-topic">{question.topic}</h3> : null}
				<p className="decide-question">{question.question}</p>
				<p className="decide-picked" data-picked={picked !== undefined || undefined}>
					{picked === undefined ? 'Zatím nevybráno' : `Vybráno: ${picked.label}`}
				</p>
			</header>
			{loading ? <p className="decide-intro">Načítám varianty…</p> : null}
			{!loading && variants.length === 0 ? (
				<p className="decide-status" role="alert">
					Žádné varianty pro {question.kind === 'stories' ? question.title : question.key}.
				</p>
			) : null}
			{current === undefined ? null : (
				<>
					<div className="decide-tabs" role="tablist" aria-label={question.topic} onKeyDown={onKeyDown}>
						{variants.map((variant, at) => (
							<button
								key={variant.value}
								ref={element => {
									tabs.current[at] = element
								}}
								type="button"
								role="tab"
								className="decide-tab"
								aria-selected={variant === current}
								tabIndex={variant === current ? 0 : -1}
								data-picked={variant.value === picked?.value || undefined}
								onClick={() => setShown(variant.value)}
							>
								{variant.value === picked?.value ? <span aria-label="vybráno">✓ </span> : null}
								{variant.label}
								{variant.recommended ? <span className="decide-rec">doporučuji</span> : null}
							</button>
						))}
					</div>
					{question.kind === 'stories' ? (
						<StoryPreview variants={variants} current={current} height={question.height ?? DEFAULT_HEIGHT} />
					) : (
						<p className="decide-detail">{current.detail}</p>
					)}
					<div className="decide-pick">
						{current.value === picked?.value ? (
							<>
								<span className="decide-picked" data-picked>
									✓ Vybráno
								</span>
								<Btn sm tone="ghost" onClick={() => onPick(undefined)}>
									Zrušit volbu
								</Btn>
							</>
						) : (
							<Btn sm tone="primary" onClick={() => onPick(current.value)}>
								Vybrat {current.code}
							</Btn>
						)}
						{question.kind === 'stories' ? (
							<a
								className="decide-open"
								href={new URL(`./?path=/story/${current.value}`, window.location.href).href}
								target="_blank"
								rel="noreferrer"
							>
								Otevřít samostatně ↗
							</a>
						) : null}
					</div>
				</>
			)}
		</article>
	)
}

/** Mounts a variant's iframe the first time it is shown while the card is near the viewport, keeps it for
 * instant switching back, and drops every iframe once the card scrolls far away (each one is a full preview). */
function StoryPreview({
	variants,
	current,
	height,
}: { variants: readonly Variant[]; current: Variant; height: number }) {
	const box = useRef<HTMLDivElement>(null)
	const [near, setNear] = useState(false)
	const [seen, setSeen] = useState<ReadonlySet<string>>(() => new Set())

	useEffect(() => {
		const element = box.current
		if (element === null) return
		const observer = new IntersectionObserver(entries => setNear(entries.some(entry => entry.isIntersecting)), {
			rootMargin: '600px 0px',
		})
		observer.observe(element)
		return () => observer.disconnect()
	}, [])

	useEffect(() => {
		if (!near) {
			if (seen.size > 0) setSeen(new Set())
		} else if (!seen.has(current.value)) setSeen(new Set([...seen, current.value]))
	}, [near, current.value, seen])

	return (
		<div ref={box} className="decide-preview" style={{ height }}>
			{variants
				.filter(variant => seen.has(variant.value))
				.map(variant => (
					<iframe
						key={variant.value}
						title={variant.label}
						src={`iframe.html?id=${encodeURIComponent(variant.value)}&viewMode=story`}
						data-shown={variant === current || undefined}
						tabIndex={variant === current ? 0 : -1}
						aria-hidden={variant !== current}
					/>
				))}
			{near ? null : <p className="decide-intro">Náhled se načte, až sem doroluješ.</p>}
		</div>
	)
}
