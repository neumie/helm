// Proposals/ — design variants waiting for Jakub's pick (docs/plans/design-system/spec.md § Open decisions).
// A proposal story renders the REAL production component/view and changes only what the variant changes, through
// token overrides on the document root (so portals, menus and toasts see them too) and, when a variant needs a rule
// the tokens cannot express, a scoped <style> block. Nothing under proposals/ is imported by production code.
import { type ReactNode, useLayoutEffect } from 'react'

export type TokenOverrides = Readonly<Record<`--${string}`, string>>

/** Applies custom-property overrides to <html> while mounted; restores the previous inline values on unmount. */
export function useTokenOverrides(overrides: TokenOverrides | undefined): void {
	const key = overrides === undefined ? '' : JSON.stringify(overrides)
	// biome-ignore lint/correctness/useExhaustiveDependencies: the serialized key is the dependency.
	useLayoutEffect(() => {
		if (overrides === undefined) return
		const root = document.documentElement
		const previous = Object.keys(overrides).map(name => [name, root.style.getPropertyValue(name)] as const)
		for (const [name, value] of Object.entries(overrides)) root.style.setProperty(name, value)
		return () => {
			for (const [name, value] of previous) {
				if (value === '') root.style.removeProperty(name)
				else root.style.setProperty(name, value)
			}
		}
	}, [key])
}

export interface ProposalProps {
	/** Decision id from the plan, e.g. "D5". */
	decision: string
	/** Variant label, e.g. "Current" or "A · lift --text-2 to AA". */
	variant: string
	/** One or two plain sentences: what changes and what it costs. */
	note: string
	/** Measured facts shown as a compact list (e.g. "--text-2 on pane 4.62:1"). */
	facts?: readonly string[]
	overrides?: TokenOverrides
	/** Extra CSS for rules tokens cannot express; keep it scoped to `.proposal-stage`. */
	css?: string
	children: ReactNode
}

/** Frame for one variant: a quiet caption strip, then the real UI on its production surface. */
export function Proposal({ decision, variant, note, facts, overrides, css, children }: ProposalProps) {
	useTokenOverrides(overrides)
	return (
		<div className="proposal" data-decision={decision}>
			<header className="proposal-caption">
				<span className="proposal-id">{decision}</span>
				<span className="proposal-variant">{variant}</span>
				<span className="proposal-note">{note}</span>
				{facts !== undefined && facts.length > 0 ? (
					<ul className="proposal-facts">
						{facts.map(fact => (
							<li key={fact}>{fact}</li>
						))}
					</ul>
				) : null}
			</header>
			{css === undefined ? null : <style>{css}</style>}
			<div className="proposal-stage">{children}</div>
		</div>
	)
}
