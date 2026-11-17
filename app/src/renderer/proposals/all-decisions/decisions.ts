// The open design-system decisions that have Storybook variants (docs/plans/design-system/spec.md § Open decisions)
// on one page, plus the open ones that are not visible as text questions (D20). Decided groups leave this list and
// their stories are deleted.
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
	{
		decision: 'D15',
		name: 'Kontrast: páry, které D5 nepokryl',
		intro: 'U každé skupiny: zvednout na AA, nebo vyjmout a zapsat výjimku.',
		questions: [
			{
				kind: 'stories',
				title: 'Proposals/D15 Contrast/Meta text on fills',
				decision: 'D15',
				topic: 'Šedý meta text na výplni',
				question:
					'Časy, čísla karet, čekání v docku a Signals a placeholdery na řádku v hoveru, stisku nebo výběru: jak na 4.5:1?',
				height: 2650,
			},
			{
				kind: 'text',
				key: 'D15/fill-strong',
				decision: 'D15',
				topic: 'Helm --text-2 na --fill-strong',
				question: 'Pár 3.34 žádné pravidlo nemaluje (High contrast ho má vyjmutý, §9 ruling 92). Co s ním v Helmu?',
				options: [
					{
						code: 'a',
						label: 'Vyjmout jako v High contrast',
						detail: 'Rozšířit §9 ruling 92 na Helm; pár zůstane v tabulce jako exempt.',
						recommended: true,
					},
					{ code: 'b', label: 'Nechat open', detail: 'Zůstane v D15, dokud ho nějaký povrch nezačne malovat.' },
				],
			},
			{
				kind: 'stories',
				title: 'Proposals/D15 Contrast/Scroll thumbs',
				decision: 'D15',
				topic: 'Jezdce posuvníků',
				question: 'Mají jezdce posuvníků (--thumb, terminál) dosáhnout 3:1, a ve kterých paletách?',
				height: 1030,
			},
			{
				kind: 'stories',
				title: 'Proposals/D15 Contrast/Terminal bright black',
				decision: 'D15',
				topic: 'Jasná černá v terminálu',
				question: 'ANSI 8 má v Helmu 2.98. Zesvětlit na 4.5:1, nebo vyjmout?',
				height: 760,
			},
			{
				kind: 'stories',
				title: 'Proposals/D15 Contrast/Chips on rows',
				decision: 'D15',
				topic: 'Čipy na řádku v hoveru a stisku',
				question: 'Červený a šedý čip klesnou na řádku v hoveru pod 4.5:1, ve stisku i modrý. Jak to vyřešit?',
				height: 1800,
			},
			{
				kind: 'stories',
				title: 'Proposals/D15 Contrast/Group band',
				decision: 'D15',
				topic: 'Text v pásu skupiny terminálů',
				question:
					'Karta, název a počet v barevném pásu skupiny jsou pod 4.5:1. Zesvětlit text, zeslabit pás, nebo vyjmout?',
				height: 480,
			},
		],
	},
	{
		decision: 'D16',
		name: 'Hodnoty Remote mimo paletu',
		intro: 'Čtyři skupiny literálů v Remote: každou převést na tokeny, nebo pojmenovat jako výjimku Remote.',
		questions: [
			{
				kind: 'stories',
				title: 'Proposals/D16 Remote values/Send button',
				decision: 'D16',
				topic: 'Tlačítko Send',
				question:
					'Bílý Send (#fff, šipka #0d0d0d): nechat jako výjimku, postavit z --text-0, nebo dát primární akcent aplikace?',
			},
			{
				kind: 'stories',
				title: 'Proposals/D16 Remote values/Shadows',
				decision: 'D16',
				topic: 'Stíny',
				question: 'Čtyři vlastní stíny (menu, drawer, sheet): na --shadow-1/--shadow-2, nový --shadow-3, nebo výjimka?',
			},
			{
				kind: 'stories',
				title: 'Proposals/D16 Remote values/Scrims',
				decision: 'D16',
				topic: 'Scrimy',
				question: 'Scrim Remote 58 % vs. --scrim 40 % (Helm): Remote na --scrim, výjimka, nebo --scrim na 58 % všude?',
			},
			{
				kind: 'stories',
				title: 'Proposals/D16 Remote values/Offline page',
				decision: 'D16',
				topic: 'Offline stránka',
				question: 'Typ a odsazení offline stránky (16/24, 48 24): stupně Remote, stupnice aplikace, nebo výjimka?',
			},
		],
	},
	{
		decision: 'D17',
		name: 'Hodnoty mimo stupnice, které D8 nevyřešilo',
		intro: 'Každá skupina zvlášť: zaokrouhlit na stupnici, nebo zapsat jako rozměr komponenty v jejím §3.',
		questions: [
			{
				kind: 'stories',
				title: 'Proposals/D17 Off-scale values/2px steps',
				decision: 'D17',
				topic: 'Mezery 2 px',
				question: 'Co s 2 px uvnitř komponent (tečky indikátoru, pruh agentů, popisek nad hodnotou, sousední ikony)?',
				height: 900,
			},
			{
				kind: 'stories',
				title: 'Proposals/D17 Off-scale values/Small radii',
				decision: 'D17',
				topic: 'Poloměry pod 4 px',
				question:
					'Co s poloměry 1 / 1.5 / 2 / 3 (tenké čáry, zaškrtávátko, vzorník barvy, nalezený výraz, stránka PDF)?',
				height: 900,
			},
			{
				kind: 'stories',
				title: 'Proposals/D17 Off-scale values/Component dimensions',
				decision: 'D17',
				topic: 'Rozměry komponent',
				question: 'Které z 14 / 18 / 22 / 28 zůstanou rozměrem komponenty a které se zaokrouhlí na stupnici?',
				height: 900,
			},
			{
				kind: 'stories',
				title: 'Proposals/D17 Off-scale values/Type sizes',
				decision: 'D17',
				topic: 'Velikosti písma',
				question:
					'Co se znaky místo ikon (9 / 14 / 16), Run Context 10 / 14 / 15, PDF heslem 14, počtem 10 a kódem 0.92em?',
				height: 900,
			},
			{
				kind: 'text',
				key: 'D17 Component metrics record',
				decision: 'D17',
				topic: 'Zápis rozměrů komponent',
				question:
					'Jak zapsat hodnoty, které zůstanou rozměrem komponenty (rezerva semaforu 84 / 90, místo pro akce řádku 84, 36–80 v Remote a prohlížeči)?',
				options: [
					{
						code: 'a',
						label: 'Řádek v §3 komponenty',
						detail: 'Výjimka v lint allowlist zůstane, její důvod cituje §3 řádek místo D17.',
						recommended: true,
					},
					{
						code: 'b',
						label: 'Pojmenované tokeny',
						detail: 'Custom properties v tokenech, např. --traffic-light-reserve; lint hodnotu nevidí.',
					},
					{
						code: 'c',
						label: 'Lint přijme násobky 4 nad 32',
						detail: 'Výjimky 36–84 zmizí bez zápisu, 90 ne (není násobek 4); žádný řádek v §3.',
					},
				],
			},
		],
	},
	{
		decision: 'D18',
		name: 'Dělicí čára v aliasu zkratky',
		questions: [
			{
				kind: 'stories',
				title: 'Proposals/D18 Shortcut alias divider',
				decision: 'D18',
				topic: 'Čára mezi zkratkou a ×',
				question:
					'Settings → Terminal: kreslit čáru mezi zkratkou a × samostatným prvkem, udělat výjimku z „žádný okraj na tlačítku“, nebo ji zrušit?',
				height: 720,
			},
		],
	},
	{
		decision: 'D19',
		name: 'Z-index a pohyb mimo tokeny',
		intro: 'Hodnoty, které žádný token nedrží, a pár míst na tokenu jiné role; viditelné jsou jen příchody v Remote.',
		questions: [
			{
				kind: 'stories',
				title: 'Proposals/D19 Z-index and motion/Remote entrances',
				decision: 'D19',
				topic: 'Příchody v Remote',
				question:
					'Šuplík a list v Remote přijíždějí 180ms po vlastní křivce, pohledy a ztmavení 160ms, menu 140ms. Srovnat na --motion-enter 150ms, dát velkým plochám nový token, nebo nechat jako metriku Remote? Zmáčkni Přehrát.',
				height: 1060,
			},
			{
				kind: 'text',
				key: 'D19-exit',
				decision: 'D19',
				topic: '120ms na tokenu odchodu',
				question:
					'Přepážka panelů při najetí, tlačítko odebrání screenshotu v Document Review a šipka u modelu ve widgetu běží na --motion-exit 120ms, i když jde o změnu stavu. Co s nimi?',
				options: [
					{
						code: 'a',
						label: 'přesunout na --motion-state 140ms',
						detail: 'Role sedí (najetí, otevřeno). O 20ms pomalejší, okem nerozlišitelné. Žádný nový token.',
						recommended: true,
					},
					{
						code: 'b',
						label: 'nový token --motion-hover 120ms',
						detail: 'Hodnota zůstane, ale přibude čtvrtý krok, který se od --motion-state liší o neviditelných 20ms.',
					},
					{
						code: 'c',
						label: 'rozšířit roli --motion-exit',
						detail: 'Kód beze změny, --motion-exit bude „odchod a rychlé odhalení“. Role tokenu se rozmaže.',
					},
				],
			},
			{
				kind: 'text',
				key: 'D19-z',
				decision: 'D19',
				topic: 'Z-index bez tokenu',
				question:
					'Widget menu More 5, zmrazený snímek terminálu 8, puls Show terminal 9, ztmavení při swipe 30, ztmavení pod šuplíkem Remote 70, Info v Remote na --z-bar 10. Kam s nimi?',
				options: [
					{
						code: 'a',
						label: 'podle role, terminál jako metrika v §3.14',
						detail:
							'Widget menu → --vg-z-menu, oba scrimy → --z-sheet, Info v Remote → --z-local-3; nic se viditelně nezmění. Terminál 8 a 9 zůstanou čísly v §3.14 („nad vrstvami xtermu 1–8“): na --z-local-* by je dekorace xtermu překryly.',
						recommended: true,
					},
					{
						code: 'b',
						label: 'nový token pro každou hodnotu',
						detail: 'Hodnoty zůstanou, tabulka §2.7 naroste o pět řádků, většinou s jedním uživatelem.',
					},
					{
						code: 'c',
						label: 'všechno jako metrika v §3 komponenty',
						detail:
							'Hodnoty zůstanou, každá zapsaná ve svém §3 (widget, swipe, Remote, terminál); lint je pustí s odkazem.',
					},
					{
						code: 'd',
						label: 'všechno podle role, terminál na --z-bar 10',
						detail:
							'Funguje (snímek i puls zůstanou nad xtermem), ale terminálové překryvy nejsou pevné lišty, role zase nesedí.',
					},
				],
			},
		],
	},
	{
		decision: 'D20',
		name: 'Kde bydlí geometrie ikon a StateGrid',
		questions: [
			{
				kind: 'text',
				key: 'D20',
				decision: 'D20',
				topic: 'Ikony a StateGrid mimo packages/helm-ui',
				question:
					'§9 ruling 106 je dává do packages/helm-ui, ale ani jedno se tam čistě nepřesune: StateGrid potřebuje React, geometrii ikon importuje produkční kód. Co s nimi? Není to vidět.',
				options: [
					{
						code: 'a',
						label: 'Nechat obojí v app/',
						detail: 'Doplnit do §9 ruling 106 výjimku. Nic se nepřesouvá.',
						recommended: true,
					},
					{
						code: 'b',
						label: 'Generovat modul ikon z balíčku',
						detail:
							'Geometrie v packages/helm-ui, generátor zapíše app/src/renderer/icons/ jako u tokenů. StateGrid zůstane v app/.',
					},
					{
						code: 'c',
						label: 'Balíček dostane React jako peer',
						detail: 'StateGrid se přesune do balíčku; Storybook musí smět číst mimo app/.',
					},
				],
			},
		],
	},
]
