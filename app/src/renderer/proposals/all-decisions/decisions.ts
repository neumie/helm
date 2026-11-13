// The open design-system decisions that have Storybook variants (docs/plans/design-system/spec.md § Open decisions)
// on one page. Decided groups leave this list and their stories are deleted; open decisions with no proposal yet
// (D15–D18) are not here.
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
		decision: 'D7',
		name: 'Dosah nastavení vzhledu',
		intro: 'High contrast, motivy a velikost UI dnes platí jen v hlavním okně a v Run context.',
		questions: [
			{
				kind: 'stories',
				title: 'Proposals/D7 Surface reach/High contrast',
				decision: 'D7',
				topic: 'High contrast v dalších oknech',
				question: 'Mají okna dokumentů, prohlížeč souborů a Remote následovat High contrast?',
			},
			{
				kind: 'stories',
				title: 'Proposals/D7 Surface reach/UI scale',
				decision: 'D7',
				topic: 'Velikost UI v dalších oknech',
				question: 'Mají stejná okna následovat nastavení velikosti UI?',
			},
		],
	},
]
