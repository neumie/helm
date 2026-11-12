// D14 · Toast stack cap (docs/plans/design-system/proposals/D14.md). §3.6 and §9 ruling 29 say at most 3 visible
// toasts; app/src/renderer/toast.ts has no cap. Every variant mounts the real terminal workspace and fires the same
// burst of six production notices (`showToast`, production copy) through a story-only policy (./toast-stack.ts) that
// only decides which earlier notice to dismiss with the production handle. The burst uses a long TTL so the end state
// stays on screen; "Replay with production TTL" fires it again with the real 4 s / 15 s grace.
import type { Meta, StoryObj } from '@storybook/react-vite'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Btn } from '../../button'
import { TerminalWorkspaceFixtureView } from '../../terminal-workspace-fixtures'
import type { ToastHandle } from '../../toast'
import { Proposal } from '../proposal'
import { type ToastPolicy, createToastStack } from './toast-stack'

/** sessions.ts closeGraceMs() default: an Undo toast lives exactly as long as the close grace. */
const CLOSE_GRACE_MS = 15_000
/** toast.ts default TTL. */
const DEFAULT_TTL_MS = 4000
/** Long enough to inspect the end state; replay uses the production values. */
const HOLD_MS = 10 * 60_000
/** Roughly one ⌘W / click per notice. */
const STAGGER_MS = 400

type Kind = 'plain' | 'undo'

/** Six notices a few hundred ms apart: save settings, move a tab to another profile, close three tabs, pick a folder. */
const BURST: readonly { kind: Kind; message: string }[] = [
	{ kind: 'plain', message: 'Settings applied' }, // SettingsPage.tsx
	{ kind: 'plain', message: 'Moved to Background in Work' }, // terminal-workspace.ts (profile move)
	{ kind: 'undo', message: 'deploy watch closed' }, // terminal-workspace.ts (close grace)
	{ kind: 'undo', message: 'api logs closed' },
	{ kind: 'undo', message: 'zsh closed' },
	{ kind: 'plain', message: 'Terminal folder updated' }, // TerminalSettingsPage.tsx
]

/** Fires the burst through `policy` on mount (held) and on Replay (production TTL); clears it on unmount. */
function Burst({ policy }: { policy: ToastPolicy }) {
	const [run, setRun] = useState<{ hold: boolean; id: number }>({ hold: true, id: 0 })
	useEffect(() => {
		const stack = createToastStack(policy)
		const timers = BURST.map(({ kind, message }, index) =>
			setTimeout(
				() => {
					if (kind === 'plain') {
						stack.show({ message, ttlMs: run.hold ? HOLD_MS : DEFAULT_TTL_MS })
						return
					}
					// Production Undo dismisses its own notice before reattaching; the story has nothing to reattach.
					let handle: ToastHandle | null = null
					handle = stack.show({
						message,
						ttlMs: run.hold ? HOLD_MS : CLOSE_GRACE_MS,
						countdown: true,
						action: { label: 'Undo', onClick: () => handle?.dismiss() },
					})
				},
				// Let the workspace mount and fit before the first notice.
				600 + index * STAGGER_MS,
			),
		)
		return () => {
			for (const timer of timers) clearTimeout(timer)
			stack.clear()
		}
	}, [policy, run])
	return (
		<div className="d14-bar">
			<Btn tone="ghost" sm onClick={() => setRun(previous => ({ hold: false, id: previous.id + 1 }))}>
				Replay with production TTL
			</Btn>
			<span className="d14-hint">6 notices, 400 ms apart · Undo 15 s, others 4 s</span>
		</div>
	)
}

/** Framing only (same in every variant): the workspace fills the viewport under the caption, so the fixed
 *  bottom-right toast stack lands over the terminal pane exactly as in the app window. */
const FRAME_CSS = `
.proposal-stage .d14-bar { display: flex; align-items: center; gap: 12px; padding: 4px 16px; border-bottom: 1px solid var(--hairline); }
.proposal-stage .d14-hint { color: var(--text-2); font: 11px / 14px var(--font-ui); }
.proposal-stage .d14-host #app { height: 100%; }
`

function Stage({ policy }: { policy: ToastPolicy }) {
	const hostRef = useRef<HTMLDivElement>(null)
	useLayoutEffect(() => {
		const host = hostRef.current
		if (!host) return
		const fit = () => {
			host.style.height = `${Math.max(240, window.innerHeight - host.getBoundingClientRect().top)}px`
		}
		fit()
		window.addEventListener('resize', fit)
		return () => window.removeEventListener('resize', fit)
	}, [])
	return (
		<>
			<Burst policy={policy} />
			<div className="d14-host" ref={hostRef}>
				<TerminalWorkspaceFixtureView options={{}} />
			</div>
		</>
	)
}

const meta: Meta = { title: 'Proposals/D14 Toast cap', parameters: { layout: 'fullscreen' } }
export default meta
type Story = StoryObj

export const Current: Story = {
	name: 'Current · bez stropu',
	render: () => (
		<Proposal
			decision="D14"
			variant="Current · bez stropu"
			note="toast.ts přidá každé oznámení do #toasts; odejde až po TTL nebo ×. Šest oznámení naráz = šest karet nad pravým dolním rohem terminálu."
			facts={[
				'viditelné 6',
				'karta 51px (× 28px), mezera 6px',
				'zásobník 336px (6 × 51 + 5 × 6)',
				'v okně 800px = 42 % výšky',
				'Undo 15s: 3 z 3 zůstanou',
			]}
			css={FRAME_CSS}
		>
			<Stage policy="stack" />
		</Proposal>
	),
}

export const A: Story = {
	name: 'A · strop 3, nejstarší odchází',
	render: () => (
		<Proposal
			decision="D14"
			variant="A · strop 3, nejstarší odchází"
			note="Čtvrté oznámení vystrčí nejstarší, ať je to cokoli. Tady zmizí Undo pro deploy watch 1,2 s po zavření, i když relace je ještě 14 s v grace: zavřený terminál už nejde vrátit. Potřebuje změnu toast.ts + test."
			facts={['viditelné 3', 'zásobník 165px (3 × 51 + 2 × 6)', 'Undo 15s: 2 z 3 zůstanou, 1 zmizí po 1,2s']}
			css={FRAME_CSS}
		>
			<Stage policy="oldest-out" />
		</Proposal>
	),
}

export const A2: Story = {
	name: 'A2 · strop 3, Undo nikdy předčasně',
	render: () => (
		<Proposal
			decision="D14"
			variant="A2 · strop 3, Undo nikdy předčasně"
			note="Předčasně odchází jen oznámení bez akce (nejstarší první). Toast s Undo zůstane celou grace, takže strop je měkký: 3 Undo + nové oznámení = 4. „Settings applied“ a „Moved to Background“ zmizí 1,2 s po zobrazení. Potřebuje změnu toast.ts + test."
			facts={['viditelné 4 (3 Undo + nejnovější)', 'zásobník 222px (4 × 51 + 3 × 6)', 'Undo 15s: 3 z 3 zůstanou']}
			css={FRAME_CSS}
		>
			<Stage policy="undo-safe" />
		</Proposal>
	),
}

export const C: Story = {
	name: 'C · strop ze specifikace pryč (doporučuji)',
	render: () => (
		<Proposal
			decision="D14"
			variant="C · strop ze specifikace pryč (doporučuji)"
			note="Pixelově stejné jako Current; mění se jen §3.6 a pravidlo 29. Doporučuji: oznámení chodí po jednom za akci a bez akce odejdou za 4 s; dávku dělá jen rychlé zavírání tabů a tam Undo odejít nesmí. Strop by tedy reálně zasáhl jen Undo, kde škodí (A), nebo by byl měkký (A2)."
			facts={['viditelné 6', 'zásobník 336px', 'Undo 15s: 3 z 3 zůstanou', 'kód beze změny']}
			css={FRAME_CSS}
		>
			<Stage policy="stack" />
		</Proposal>
	),
}
