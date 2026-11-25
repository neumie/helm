// The open design-system decisions that have Storybook variants (docs/plans/design-system/spec.md § Open decisions)
// on one page, plus open ones that are not visible as text questions. Decided groups leave this list and their
// stories are deleted; an open decision with no proposal yet is not listed until its Proposals/ stories exist.
// Visible decisions name their Proposals/ story group; the page reads that group's variants from the Storybook
// index, so a new variant shows up without editing this file. tests/design-proposals-order.test.ts checks that
// every Proposals/ group has an entry here and every entry names an existing group.

export interface TextOption {
	/** Short code Jakub answers with, e.g. "a". */
	code: string
	label: string
	detail: string
	recommended?: boolean
}

/** A structural decision with no Storybook variants: the options are text. */
export interface TextQuestion {
	kind: 'text'
	key: string
	decision: string
	topic: string
	question: string
	options: readonly TextOption[]
}

/** A visible decision: the options are the stories of one Proposals/ group. */
export interface StoryQuestion {
	kind: 'stories'
	/** The story group title, e.g. "Proposals/D5 Contrast/Meta text". Also the pick key. */
	title: string
	decision: string
	topic: string
	question: string
	/** Preview height in px when the default does not show the variant's point. */
	height?: number
}

export type Question = TextQuestion | StoryQuestion

export interface DecisionGroup {
	decision: string
	name: string
	/** One sentence before the sub-questions, only when the group has several. */
	intro?: string
	questions: readonly Question[]
}

export const questionKey = (question: Question): string => (question.kind === 'text' ? question.key : question.title)

export const DECISIONS: readonly DecisionGroup[] = [
	{
		decision: 'D27',
		name: 'Odezva rychlé odpovědi v Signals',
		questions: [
			{
				kind: 'stories',
				title: 'Proposals/D27 Quick answer feedback/Signals detail',
				decision: 'D27',
				topic: 'Po kliknutí na rychlou odpověď',
				question:
					'Když v detailu asku klikneš na rychlou odpověď („Jo“), skoro nejde poznat, že se něco stalo. Jak to má panel ukázat?',
				height: 760,
			},
		],
	},
]
