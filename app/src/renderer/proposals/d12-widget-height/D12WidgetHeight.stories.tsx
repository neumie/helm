// D12 — the extension widget's buttons, agent/workspace segmented and model trigger are 28px; §3.1 md is 32
// (docs/plans/design-system/proposals/D12.md). Every variant mounts the REAL production widget through the
// `Views / Extension widget / Closed shadow` story (production `mountWidget`, closed shadow root, fixture services).
// The widget's CSS lives inside its closed shadow root, so token overrides on <html> cannot reach it: a variant
// appends one story-only <style> after the production one through the workbench's fixture-only `query()` reference
// to that root (the same reference the browser tests use). Production files are untouched.
import type { Meta, StoryObj } from '@storybook/react-vite'
import { composeStories } from '@storybook/react-vite'
import { useEffect, useState } from 'react'
import * as WidgetStories from '../../sidebar/ExtensionWidget.stories'
import { Proposal } from '../proposal'

const { ClosedShadow } = composeStories(WidgetStories)

/** Fixture-only workbench harness (extension/src/widget-workbench.tsx); `query` reads inside the closed root. */
interface WorkbenchHarness {
	query(selector: string): HTMLElement | null
	text(): string
}
const workbench = (): WorkbenchHarness | undefined =>
	(window as unknown as { extensionWorkbench?: WorkbenchHarness }).extensionWorkbench

/** §3.1 md button: 32, padding 0 14, 13/600, radius 8 (widget `--vg-radius-lg`). The `.vg-pr` link-button follows. */
const MD_BUTTONS = `
.vg-btn { height: 32px; padding: 0 14px; font-size: 13px; border-radius: var(--vg-radius-lg); }
.vg-pr { height: 32px; }
`

/** Variant B also lifts the segmented track, the model trigger and the Custom model field (29 today) to 32;
 * segmented options go to 28 so the 2px track inset stays. */
const ALL_32 = `${MD_BUTTONS}
.vg-agent { min-height: 32px; }
.vg-run-menu input { height: 32px; }
.vg-agent__seg { height: 32px; }
.vg-agent__option { height: 28px; }
.vg-model__trigger { height: 32px; }
`

interface Measured {
	card: number
	body: number
	actions: number
	button: number
	segmented: number
	trigger: number
}

const px = (element: HTMLElement | null): number => Math.round((element?.getBoundingClientRect().height ?? 0) * 10) / 10

/** Mounts the production widget, applies the variant CSS, opens the card (the Inbox pill) and measures it. */
function Widget({ css, onMeasured }: { css: string | undefined; onMeasured: (measured: Measured) => void }) {
	useEffect(() => {
		let cancelled = false
		const deadline = Date.now() + 10000
		const wait = async <T,>(find: () => T | null | undefined, what: string): Promise<T> => {
			for (;;) {
				if (cancelled) throw new Error('cancelled')
				const found = find()
				if (found) return found
				if (Date.now() > deadline) throw new Error(`D12 story: ${what} did not appear`)
				await new Promise(resolve => setTimeout(resolve, 50))
			}
		}
		void (async () => {
			const harness = await wait(workbench, 'workbench harness')
			const productionStyle = await wait(() => harness.query('style'), 'widget style')
			if (css !== undefined) {
				const extra = document.createElement('style')
				extra.dataset.proposal = 'D12'
				extra.textContent = css
				productionStyle.after(extra)
			}
			const pill = await wait(() => harness.query('.vg-pill'), 'widget pill')
			pill.click()
			await wait(
				() => harness.query('.vg-card') && harness.text().includes('Source narrative'),
				'expanded card with run context',
			)
			// The agent/workspace segmented and the model trigger live in the "Run with …" disclosure; open it.
			const runMenu = await wait(() => harness.query('.vg-run-menu'), 'Run with disclosure')
			if (runMenu instanceof HTMLDetailsElement) runMenu.open = true
			await new Promise(resolve => requestAnimationFrame(resolve))
			const card = await wait(() => harness.query('.vg-card'), 'card')
			onMeasured({
				card: px(card),
				body: px(harness.query('.vg-card__body')),
				actions: px(harness.query('.vg-card__actions')),
				button: px(harness.query('.vg-card__actions .vg-btn')),
				segmented: px(harness.query('.vg-agent__seg')),
				trigger: px(harness.query('.vg-model__trigger')),
			})
		})().catch(error => {
			if (!cancelled) console.error(error)
		})
		return () => {
			cancelled = true
		}
	}, [css, onMeasured])
	return <ClosedShadow />
}

function Variant({
	variant,
	note,
	facts,
	css,
}: {
	variant: string
	note: string
	facts: readonly string[]
	css?: string
}) {
	const [measured, setMeasured] = useState<Measured | null>(null)
	const live =
		measured === null
			? ['měřím…']
			: [
					`naměřeno: karta ${measured.card} px (tělo ${measured.body}, lišta akcí ${measured.actions})`,
					`tlačítko ${measured.button} · segmented ${measured.segmented} · model ${measured.trigger}`,
				]
	return (
		<Proposal decision="D12" variant={variant} note={note} facts={[...facts, ...live]}>
			<Widget css={css} onMeasured={setMeasured} />
		</Proposal>
	)
}

const meta: Meta = { title: 'Proposals/D12 Widget height', parameters: { layout: 'fullscreen' } }
export default meta
type Story = StoryObj

export const Current: Story = {
	name: 'Current · 28',
	render: () => (
		<Variant
			variant="Current · 28"
			note="Tlačítka (.vg-btn), segmented výběr agenta a workspace i spouštěč modelu mají 28px. §3.1 md tlačítko je 32 a 28px textové tlačítko v §3.1 není; segmented 28 (§3.2) a pole 28 (§3.7) spec už má."
			facts={[
				'.vg-btn 28 · 0 12 · 12/600 · rádius 6',
				'karta 332 px široká; výška 433 px s otevřeným Run with, 320 px se zavřeným',
			]}
		/>
	),
}

export const A: Story = {
	name: 'A · 28 jako „dense card“ v §3.1',
	render: () => (
		<Variant
			variant="A · 28 jako „dense card“ v §3.1"
			note="Pixely beze změny. §3.1 dostane třetí textovou velikost „dense“ 28 · 0 12 · 12/600 · rádius 6, kterou používá jen widget. Cena: velikost tlačítka, kterou nemá žádný jiný povrch Helm."
			facts={['vypadá jako Current', 'nová řádka v §3.1 + výjimka v lintu S3 jen pro widget']}
		/>
	),
}

export const B: Story = {
	name: 'B · všechno 32 (md)',
	render: () => (
		<Variant
			variant="B · všechno 32 (md)"
			note="Tlačítka jako §3.1 md (32 · 0 14 · 13/600 · rádius 8); segmented, spouštěč modelu i pole Custom model také 32, aby řádky seděly. Cena: §3.2 (segmented 28) a §3.7 (pole 28) by potřebovaly výjimku pro widget, karta je vyšší."
			facts={[
				'segmented 32, volby 28 (vnitřní okraj 2 zůstává)',
				'pole Custom model 29 → 32',
				'řádky Run with min. 32',
				'karta 433 → 452 px (+19) s otevřeným Run with, 320 → 324 (+4) se zavřeným',
			]}
			css={ALL_32}
		/>
	),
}

export const C: Story = {
	name: 'C · tlačítka 32, segmented a model 28 (doporučuji)',
	render: () => (
		<Variant
			variant="C · tlačítka 32, segmented a model 28 (doporučuji)"
			note="Jen tlačítka (a odkaz PR) na §3.1 md; segmented a spouštěč modelu zůstávají 28. Stejná gramatika jako detail v sidebaru (md tlačítka 32, Segmented 28, pole 28), takže widget nepotřebuje žádnou výjimku. Cena: lišta akcí o 4px vyšší."
			facts={[
				'.vg-btn 32 · 0 14 · 13/600 · rádius 8',
				'segmented 28 (§3.2), model 28 (§3.7) beze změny',
				'karta 433 → 437 px (+4) s otevřeným Run with, 320 → 324 (+4) se zavřeným',
			]}
			css={MD_BUTTONS}
		/>
	),
}
