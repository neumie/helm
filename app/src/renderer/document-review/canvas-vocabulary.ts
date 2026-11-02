/** Inert display vocabulary only; source/field authority remains independently validated. */
export const canvasTags: ReadonlySet<string> = new Set(
	'div span p h1 h2 h3 h4 h5 h6 section article header footer main aside nav ul ol li strong em b i small code pre blockquote br hr table thead tbody tr th td button label input textarea select option optgroup fieldset legend output details summary'.split(
		' ',
	),
)
export const canvasTextProps: ReadonlySet<string> = new Set(
	'id title aria-label aria-describedby aria-labelledby aria-live role htmlFor name label placeholder value defaultValue type'.split(
		' ',
	),
)
export const canvasBooleanProps: ReadonlySet<string> = new Set(
	'disabled checked defaultChecked multiple readOnly selected required open'.split(' '),
)
export const canvasBooleanishProps: ReadonlySet<string> = new Set(['aria-expanded', 'aria-checked'])
export const canvasNumberProps: ReadonlySet<string> = new Set(
	'rows cols min max step maxLength start colSpan rowSpan'.split(' '),
)
export const canvasStyles: ReadonlySet<string> = new Set(
	'color backgroundColor fontSize fontWeight fontStyle textAlign textDecoration lineHeight whiteSpace display gap padding paddingTop paddingBottom paddingLeft paddingRight margin marginTop marginBottom marginLeft marginRight borderRadius borderWidth borderStyle borderColor width maxWidth minWidth height maxHeight minHeight flex flexDirection flexWrap alignItems justifyContent gridTemplateColumns'.split(
		' ',
	),
)
/** Display budgets shared by the canvas Worker and the parent-side frame validator. */
export const canvasLimits = { nodes: 8192, depth: 32, textUnits: 64000, frameBytes: 1024 * 1024 } as const
/** Fixed, producer-independent explanations for an exceeded display budget. */
export const canvasLimitReasons = {
	nodes: `more than ${canvasLimits.nodes} rendered nodes`,
	depth: `nesting deeper than ${canvasLimits.depth} elements`,
	text: `more than ${canvasLimits.textUnits} characters of text`,
	frame: 'rendered output larger than 1 MiB',
	style: 'more than 40 style properties on one element',
	value: 'a field or option value longer than 4000 characters',
	fields: 'more than 16 feedback fields or 16384 field characters',
} as const
export type CanvasLimit = keyof typeof canvasLimitReasons
export const canvasInputTypes: ReadonlySet<string> = new Set(['text', 'number', 'checkbox', 'radio', 'email'])

export function isCanvasScalarProp(key: string, value: unknown): value is string | number | boolean {
	if (key === 'value' || key === 'defaultValue') {
		if (typeof value === 'number' && Number.isFinite(value)) return true
	}
	if (canvasTextProps.has(key)) return typeof value === 'string' && value.length <= 4000
	if (canvasBooleanProps.has(key)) return typeof value === 'boolean'
	if (canvasBooleanishProps.has(key))
		return typeof value === 'boolean' || (typeof value === 'string' && value.length <= 4000)
	return (
		canvasNumberProps.has(key) &&
		((typeof value === 'number' && Number.isFinite(value)) ||
			(typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value)))
	)
}

export function isCanvasStyle(name: string, value: unknown): value is string | number {
	return (
		canvasStyles.has(name) &&
		((typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 10000) ||
			(typeof value === 'string' &&
				value.length <= 120 &&
				/^[\w\s.,%#()+\-]*$/.test(value) &&
				!/url|expression|image|var\s*\(/i.test(value)))
	)
}
