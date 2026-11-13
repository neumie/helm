// Every open design-system decision (docs/plans/design-system/spec.md § Open decisions) on one page.
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
		decision: 'D1',
		name: 'Sdílení mezi aplikací a rozšířením',
		questions: [
			{
				kind: 'text',
				key: 'D1',
				decision: 'D1',
				topic: 'Sdílení',
				question: 'Jak mají aplikace (React) a rozšíření (SolidJS) sdílet design systém?',
				options: [
					{
						code: 'a',
						label: 'a · tokeny generované, komponenty zvlášť',
						detail:
							'Jeden zdroj tokenů zapíše i soubor --vg-* pro rozšíření. Komponenty zůstanou v každém frameworku zvlášť a drží je spec a stories. Levné, žádné provázání buildů.',
						recommended: true,
					},
					{
						code: 'b',
						label: 'b · společný CSS balík komponent',
						detail:
							'Jeden CSS balík tříd, který importují oba a rozšíření ho nese ve svém shadow rootu. Bez duplicitního CSS, ale build rozšíření závisí na CSS aplikace a widget naroste.',
					},
					{
						code: 'c',
						label: 'c · přepsat widget do Reactu',
						detail: 'Sdílené komponenty doslova. Největší práce a mění pravidlo v AGENTS.md (rozšíření je SolidJS).',
					},
				],
			},
		],
	},
	{
		decision: 'D2',
		name: 'Kde design systém bydlí',
		questions: [
			{
				kind: 'text',
				key: 'D2',
				decision: 'D2',
				topic: 'Umístění',
				question: 'Kam v repu patří tokeny, ikony a Storybook pomůcky? Na tomhle stojí S2 (generování tokenů).',
				options: [
					{
						code: 'a',
						label: 'a · uvnitř app/',
						detail:
							'app/src/design/ a app/src/renderer/{icons,storybook}. Žádné nové propojení balíků, Storybook už v app/ je.',
						recommended: true,
					},
					{
						code: 'b',
						label: 'b · samostatný balík packages/helm-ui',
						detail:
							'Jako @tally/ui: vlastní Storybook, tsconfig a exporty. Čistší hranice, ale tři balíky Helmu mají tři různé správce balíčků a build aplikace by potřeboval krok navíc.',
					},
				],
			},
		],
	},
	{
		decision: 'D3',
		name: 'Hlídání bez CI',
		questions: [
			{
				kind: 'text',
				key: 'D3',
				decision: 'D3',
				topic: 'Kontrola',
				question: 'main se nikam nepushuje, takže CI nic nehlídá. Jak vynutit kontroly designu?',
				options: [
					{
						code: 'a',
						label: 'a · npm run check:design povinně podle AGENTS.md',
						detail: 'Rychlé části běží i v npm test. Tak to funguje dnes.',
						recommended: true,
					},
					{
						code: 'b',
						label: 'b · navíc git pre-commit hook',
						detail: 'Rychlé části při každém commitu (asi 2 s navíc, i agentům ve worktrees).',
					},
				],
			},
		],
	},
	{
		decision: 'D4',
		name: 'Nedefinované tokeny',
		intro: 'Kód používá tokeny, které nikdo nedefinoval, takže prohlížeč vezme výchozí hodnotu.',
		questions: [
			{
				kind: 'stories',
				title: 'Proposals/D4 Radius',
				decision: 'D4',
				topic: 'Rohy',
				question:
					'--radius-sm/md/lg nejsou definované, takže čtyři místa mají hranaté rohy (spec říká 6/4/8). Zakulatit podle specifikace, nebo nechat hranaté pravidlem?',
			},
			{
				kind: 'stories',
				title: 'Proposals/D4 Accent text',
				decision: 'D4',
				topic: 'Barva odkazu',
				question:
					'--accent-text taky chybí, takže text zdědí barvu okolí. Dát mu barvu akcentu, nebo pravidlem bez akcentu?',
			},
		],
	},
	{
		decision: 'D5',
		name: 'Kontrast',
		intro: 'WCAG AA chce 4.5:1 pro text a 3:1 pro okraje ovládacích prvků. Tyhle dvojice dnes nevyhovují.',
		questions: [
			{
				kind: 'stories',
				title: 'Proposals/D5 Contrast/Meta text',
				decision: 'D5',
				topic: 'Šedý meta text',
				question: 'Meta text (--text-2) má 2.96–3.28:1. Zesvětlit, nebo nechat jako výjimku?',
			},
			{
				kind: 'stories',
				title: 'Proposals/D5 Contrast/Primary button',
				decision: 'D5',
				topic: 'Hlavní tlačítko',
				question: 'Bílý text na hlavním tlačítku má 3.68:1, při najetí 2.73. Jak dosáhnout AA?',
			},
			{
				kind: 'stories',
				title: 'Proposals/D5 Contrast/Control edges',
				decision: 'D5',
				topic: 'Okraje polí',
				question: 'Okraje polí a ovládacích prvků mají 1.20 a 1.62:1. Zesílit, nebo je uznat jako dekorativní?',
			},
			{
				kind: 'stories',
				title: 'Proposals/D5 Contrast/High contrast preset',
				decision: 'D5',
				topic: 'Preset High contrast',
				question: 'I preset High contrast padá: tlačítko 4.46:1, okraje 2.84:1. Co opravit?',
			},
			{
				kind: 'stories',
				title: 'Proposals/D5 Contrast/Remote meta',
				decision: 'D5',
				topic: 'Remote meta text',
				question: 'Meta text v Remote na bublině zprávy má 2.32:1.',
			},
			{
				kind: 'stories',
				title: 'Proposals/D5 Contrast/Review light',
				decision: 'D5',
				topic: 'Světlé čtení dokumentu',
				question: 'Ve světlém čtení dokumentu má accent na podkladu 4.499:1 a --neutral 2.70:1.',
			},
		],
	},
	{
		decision: 'D6',
		name: 'Ikony',
		questions: [
			{
				kind: 'stories',
				title: 'Proposals/D6 Icons',
				decision: 'D6',
				topic: 'Ikony',
				question:
					'21 z 23 ikon je kreslených ručně, AGENTS.md chce ikony ze zavedené sady. Kterou sadu a velikost? Nebo nechat ruční sadu jako vlastní (Current)?',
				height: 760,
			},
		],
	},
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
			{
				kind: 'stories',
				title: 'Proposals/D7 Surface reach/Remote palette',
				decision: 'D7',
				topic: 'Paleta Remote',
				question:
					'Remote má vlastní tmavší paletu, nikde nezapsanou. Převzít paletu aplikace, nebo ji zapsat jako pravidlo?',
			},
		],
	},
	{
		decision: 'D8',
		name: 'Hodnoty mimo stupnici',
		intro: 'U každé hodnoty mimo stupnici: srovnat na stupnici, nebo stupnici rozšířit pravidlem.',
		questions: [
			{
				kind: 'stories',
				title: 'Proposals/D8 Scale/Button radius',
				decision: 'D8',
				topic: 'Rohy tlačítek',
				question: 'Tabulka §2.4 říká tlačítko 6, §3.1 říká 8. Která platí?',
			},
			{
				kind: 'stories',
				title: 'Proposals/D8 Scale/Count badges',
				decision: 'D8',
				topic: 'Počty v odznacích',
				question: 'Počty mají 10 px a tučnost 700, obojí mimo stupnici.',
			},
			{
				kind: 'stories',
				title: 'Proposals/D8 Scale/Font weights',
				decision: 'D8',
				topic: 'Tučnost písma',
				question: 'Rozšíření používá tučnost 650 a 700, povolené jsou 400/500/600.',
			},
			{
				kind: 'stories',
				title: 'Proposals/D8 Scale/Letter-spacing',
				decision: 'D8',
				topic: 'Prostrkání',
				question: 'Klávesy mají +0.04em a kód +0.08em, spec žádné prostrkání nepovoluje.',
			},
			{
				kind: 'stories',
				title: 'Proposals/D8 Scale/Remote radii',
				decision: 'D8',
				topic: 'Rohy v Remote',
				question: 'Remote má rohy 10/12/18/24/28, mimo stupnici.',
			},
			{
				kind: 'stories',
				title: 'Proposals/D8 Scale/Remote type',
				decision: 'D8',
				topic: 'Písmo v Remote',
				question: 'Remote má velikosti písma 14/16/20, mimo stupnici.',
			},
			{
				kind: 'stories',
				title: 'Proposals/D8 Scale/Spacing',
				decision: 'D8',
				topic: 'Mezery',
				question: 'Mezery 6, 10 a liché hodnoty jsou mimo stupnici 4/8/12/16.',
			},
		],
	},
	{
		decision: 'D9',
		name: 'Popup rozšíření',
		questions: [
			{
				kind: 'stories',
				title: 'Proposals/D9 Extension popup',
				decision: 'D9',
				topic: 'Popup rozšíření',
				question: 'Popup rozšíření má barvy VS Code. Převést na barvy Helmu?',
			},
		],
	},
	{
		decision: 'D10',
		name: 'Soubory motivů',
		questions: [
			{
				kind: 'stories',
				title: 'Proposals/D10 Theme files',
				decision: 'D10',
				topic: 'Soubory motivů',
				question:
					'Motivy se zkopírují jednou a po aktualizaci se neobnoví: nainstalovaný High contrast má 44 z 54 tokenů, zbytek bere z Helmu. Obnovovat přibalené motivy?',
			},
		],
	},
	{
		decision: 'D11',
		name: 'Přepínače',
		questions: [
			{
				kind: 'stories',
				title: 'Proposals/D11 Toggles',
				decision: 'D11',
				topic: 'Přepínače',
				question:
					'Pravidlo: na ploše nejvýš jeden prvek vyplněný akcentem. Každý zapnutý přepínač ho má, takže Settings jich ukážou víc.',
			},
		],
	},
	{
		decision: 'D12',
		name: 'Výška ovládání v rozšíření',
		questions: [
			{
				kind: 'stories',
				title: 'Proposals/D12 Widget height',
				decision: 'D12',
				topic: 'Výška ovládání',
				question: 'Tlačítka a výběry v rozšíření mají 28 px, spec říká 32.',
			},
		],
	},
	{
		decision: 'D13',
		name: 'Velikost UI v postranním panelu',
		questions: [
			{
				kind: 'stories',
				title: 'Proposals/D13 UI scale',
				decision: 'D13',
				topic: 'Pevné velikosti písma',
				question:
					'Některé texty ignorují nastavení velikosti UI, např. zkratky v menu (11px). Mění se jen při velikosti jiné než výchozí.',
			},
		],
	},
	{
		decision: 'D14',
		name: 'Strop toastů',
		questions: [
			{
				kind: 'stories',
				title: 'Proposals/D14 Toast cap',
				decision: 'D14',
				topic: 'Strop toastů',
				question: 'Spec říká nejvýš 3 toasty najednou, kód žádný strop nemá.',
			},
		],
	},
]
