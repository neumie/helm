// D27 (docs/plans/design-system/spec.md § Open decisions): how the Signals detail panel shows that a quick answer
// was sent. Each variant is the production Signals column on its fixture services, the dispatcher's ask (505,
// quick answers Ano / Ne) open in the slide-over over the terminals; 1.5 s after load the first quick answer is
// pressed, the dock takes 0.7 s to type it in. Captions Czech, UI English. Nothing here is imported by production.
import type { Meta, StoryObj } from '@storybook/react-vite'
import type { AnswerFeedback } from '../../signals/Signals'
import { SignalsWorkspace } from '../../signals/SignalsWorkspace'
import { Proposal } from '../proposal'

// The workspace shell is 100vh tall; inside the caption frame it takes the stage's height instead.
const FRAME_CSS = `
.proposal { height: 100vh; }
.proposal-stage { display: flex; flex-direction: column; }
.proposal-stage #app { height: auto; flex: 1 1 auto; min-height: 0; }
`

const AUTO = 'Za 1,5 s po načtení se samo stiskne „Ano“'
const TRY = `${AUTO}; pak zkus kliknout na „Ne“ nebo stisknout 2.`

function Variant({
	feedback,
	variant,
	note,
	tryIt = TRY,
}: { feedback: AnswerFeedback; variant: string; note: string; tryIt?: string }) {
	return (
		<Proposal decision="D27" variant={variant} note={`${note} ${tryIt}`} css={FRAME_CSS}>
			<SignalsWorkspace scenario="detail" detail={505} answerFeedback={feedback} autoAnswer={1500} answerDelay={700} />
		</Proposal>
	)
}

const meta: Meta<typeof Variant> = {
	title: 'Proposals/D27 Quick answer feedback/Signals detail',
	component: Variant,
	parameters: { layout: 'fullscreen' },
}
export default meta
type Story = StoryObj<typeof Variant>

export const Current: Story = {
	name: 'Current',
	args: {
		feedback: 'note',
		variant: 'Current · poznámka v patičce',
		note: 'Dnes: obě tlačítka jen na chvíli zešednou, pak malá šedá poznámka v patičce „Replied to …“ a ✓ u řádku v seznamu. Panel vypadá stejně jako předtím.',
	},
}

export const Picked: Story = {
	name: 'A · stisknutá odpověď a potvrzení',
	args: {
		feedback: 'picked',
		variant: 'A · stisknutá odpověď a potvrzení',
		note: 'Odeslaná odpověď zůstane stisknutá (výplň, číslo se změní na zelené ✓) a pod odpověďmi je řádek v čitelné velikosti „✓ Replied to … · “Ano” · just now“. Patička ho neopakuje. Po znovuotevření panelu je odpověď pořád vidět.',
	},
}

export const Answered: Story = {
	name: 'B · ask se sbalí na odpověď',
	args: {
		feedback: 'answered',
		variant: 'B · ask se sbalí na odpověď',
		note: 'Rychlé odpovědi i pole zmizí a místo nich je „Your answer: Ano“ s ✓ a komu to šlo; „Answer again“ (nebo r) je vrátí. Nejjasnější stav „hotovo“, ale odpovědět jinak stojí klik navíc.',
		tryIt: `${AUTO}; pak zkus „Answer again“ (nebo r) a odpověz jinak.`,
	},
}

export const Flash: Story = {
	name: 'C · záblesk a toast',
	args: {
		feedback: 'flash',
		variant: 'C · záblesk a toast',
		note: 'Stisknuté tlačítko jednou zezelená (1,4 s jako příchod v docku) a vpravo dole vyjede toast „Replied to …“ s odpovědí. Panel jinak zůstane jako dnes; po zmizení toastu zbyde jen poznámka v patičce.',
	},
}
