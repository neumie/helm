import type {
	CanvasDisplayFrame,
	CanvasDisplayNode,
	CanvasFieldValue,
	CanvasSourceBlock,
	ReviewCanvasCompilation,
} from '../../document-review/types'

export function canvasSourceBlock(
	compilation: ReviewCanvasCompilation | undefined,
	id: string,
	sourceUnits: number,
): CanvasSourceBlock | null {
	if (!compilation || compilation.error || !compilation.code || !id || id.length > 80) return null
	const matches = compilation.blocks.filter(block => block.id === id)
	const block = matches[0]
	return matches.length === 1 &&
		block &&
		Number.isSafeInteger(block.start) &&
		Number.isSafeInteger(block.end) &&
		block.start >= 0 &&
		block.end > block.start &&
		block.end <= sourceUnits
		? block
		: null
}

export function canvasWorkerInvocation(compilation: ReviewCanvasCompilation): string {
	if (!compilation.code || compilation.error) throw new Error('Canvas compilation unavailable')
	return `\nHelmReviewCanvasWorker.startReviewCanvas((module,exports,require,__helmCanvasRuntime)=>{\n${compilation.code}\n},${JSON.stringify({ blocks: compilation.blocks, fieldIds: compilation.fieldIds })});`
}

export interface ValidatedCanvasNode extends Omit<CanvasDisplayNode, 'props' | 'children'> {
	/** Private runtime provenance, never inferred from producer props/id. */
	sourceId?: string
	props: Record<string, string | number | boolean | string[] | Record<string, string | number>>
	children: (string | ValidatedCanvasNode)[]
}
export interface ValidatedCanvasFrame extends Omit<CanvasDisplayFrame, 'nodes'> {
	nodes: (string | ValidatedCanvasNode)[]
}

export function validateCanvasValues(value: unknown): string[] {
	if (!Array.isArray(value) || value.length > 64) fail()
	let units = 0
	return value.map(item => {
		if (typeof item !== 'string' || item.length > 4000) fail()
		units += item.length
		if (units > 16384) fail()
		return item
	})
}

export const canvasTags = new Set(
	'div span p h1 h2 h3 h4 h5 h6 section article header footer main aside nav ul ol li strong em b i small code pre blockquote br hr table thead tbody tr th td button label input textarea select option fieldset legend output'.split(
		' ',
	),
)
const textProps = new Set([
	'id',
	'title',
	'aria-label',
	'aria-describedby',
	'aria-labelledby',
	'role',
	'htmlFor',
	'name',
	'placeholder',
	'value',
	'defaultValue',
	'type',
])
const booleanProps = new Set(['disabled', 'checked', 'defaultChecked', 'multiple', 'readOnly', 'selected'])
const numberProps = new Set(['rows', 'cols', 'min', 'max', 'step', 'maxLength', 'start', 'colSpan', 'rowSpan'])
const styles = new Set(
	'color backgroundColor fontSize fontWeight fontStyle textAlign textDecoration lineHeight whiteSpace display gap padding paddingTop paddingBottom paddingLeft paddingRight margin marginTop marginBottom marginLeft marginRight borderRadius borderWidth borderStyle borderColor width maxWidth minWidth height maxHeight minHeight flex flexDirection flexWrap alignItems justifyContent gridTemplateColumns'.split(
		' ',
	),
)
const inputTypes = new Set(['text', 'number', 'checkbox', 'radio', 'email'])
function record(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value)
}
function fail(): never {
	throw new Error('Document canvas display is unavailable. Read the source instead.')
}

/** Independent parent-side validation. No producer HTML, URLs, CSS capabilities or spread props. */
export function validateCanvasFrame(
	value: unknown,
	compilation: ReviewCanvasCompilation,
	sourceUnits = 512 * 1024,
): ValidatedCanvasFrame {
	if (
		!record(value) ||
		Object.keys(value).some(key => !['nodes', 'fields'].includes(key)) ||
		!Array.isArray(value.nodes) ||
		!Array.isArray(value.fields)
	)
		fail()
	let count = 0
	let text = 0
	const ids = new Set<string>()
	const attestedFields = new Set(
		compilation.fieldIds.filter(id => typeof id === 'string' && canvasSourceBlock(compilation, id, sourceUnits)),
	)
	const sourceIds = new Map<string, number>()
	const controlIds = new Set<string>()
	const node = (value: unknown, depth: number): string | ValidatedCanvasNode => {
		if (depth > 32 || ++count > 2048) fail()
		if (typeof value === 'string') {
			text += value.length
			if (text > 64000) fail()
			return value
		}
		if (
			!record(value) ||
			Object.keys(value).some(key => !['id', 'tag', 'props', 'children', 'events', 'sourceId'].includes(key)) ||
			typeof value.id !== 'string' ||
			!value.id ||
			value.id.length > 80 ||
			ids.has(value.id) ||
			typeof value.tag !== 'string' ||
			!canvasTags.has(value.tag) ||
			!record(value.props) ||
			!Array.isArray(value.children)
		)
			fail()
		ids.add(value.id)
		const props: ValidatedCanvasNode['props'] = {}
		for (const [key, prop] of Object.entries(value.props)) {
			if (key === 'style') {
				if (!record(prop) || Object.keys(prop).length > 40) fail()
				const safe: Record<string, string | number> = {}
				for (const [name, css] of Object.entries(prop)) {
					if (
						!styles.has(name) ||
						!(
							(typeof css === 'number' && Number.isFinite(css) && Math.abs(css) <= 10000) ||
							(typeof css === 'string' &&
								css.length <= 120 &&
								/^[\w\s.,%#()+\-]*$/.test(css) &&
								!/url|expression|image|var\s*\(/i.test(css))
						)
					)
						fail()
					safe[name] = css as string | number
				}
				props.style = safe
			} else if (
				['value', 'defaultValue'].includes(key) &&
				Array.isArray(prop) &&
				value.tag === 'select' &&
				value.props.multiple === true
			) {
				props[key] = validateCanvasValues(prop)
				text += (props[key] as string[]).reduce((sum, item) => sum + item.length, 0)
			} else if (['value', 'defaultValue'].includes(key) && typeof prop === 'number' && Number.isFinite(prop))
				props[key] = prop
			else if (textProps.has(key) && typeof prop === 'string' && prop.length <= 4000) {
				text += prop.length
				props[key] = prop
			} else if (booleanProps.has(key) && typeof prop === 'boolean') props[key] = prop
			else if (
				numberProps.has(key) &&
				((typeof prop === 'number' && Number.isFinite(prop)) ||
					(typeof prop === 'string' && /^-?\d+(\.\d+)?$/.test(prop)))
			)
				props[key] = prop
			else fail()
		}
		if (text > 64000 || Object.keys(props).length > 40) fail()
		let provenance: string | undefined
		if (value.sourceId !== undefined) {
			if (
				typeof value.sourceId !== 'string' ||
				!value.sourceId ||
				value.sourceId.length > 80 ||
				value.sourceId !== props.id ||
				!canvasSourceBlock(compilation, value.sourceId, sourceUnits)
			)
				fail()
			provenance = value.sourceId
		}
		if (props.id) sourceIds.set(String(props.id), (sourceIds.get(String(props.id)) ?? 0) + 1)
		if (value.tag === 'input' && !inputTypes.has(String(props.type ?? 'text'))) fail()
		if (value.tag === 'button') props.type = 'button'
		if (
			['input', 'textarea', 'select'].includes(value.tag) &&
			!(value.tag === 'select' && props.multiple === true) &&
			provenance !== undefined &&
			attestedFields.has(provenance)
		)
			controlIds.add(provenance)
		let events: CanvasDisplayNode['events']
		if (value.events !== undefined) {
			if (!record(value.events) || Object.keys(value.events).some(key => !['click', 'change'].includes(key))) fail()
			events = {}
			for (const [key, handle] of Object.entries(value.events)) {
				if (typeof handle !== 'string' || !handle || handle.length > 80) fail()
				events[key as 'click' | 'change'] = handle
			}
		}
		return {
			id: value.id,
			tag: value.tag,
			props,
			children: value.children.map(child => node(child, depth + 1)),
			...(events ? { events } : {}),
			...(provenance ? { sourceId: provenance } : {}),
		}
	}
	const nodes = value.nodes.map(value => node(value, 0))
	const deauthorizeDuplicates = (nodes: (string | ValidatedCanvasNode)[]) => {
		for (const node of nodes)
			if (typeof node !== 'string') {
				if (node.sourceId && sourceIds.get(node.sourceId) !== 1) node.sourceId = undefined
				deauthorizeDuplicates(node.children)
			}
	}
	deauthorizeDuplicates(nodes)
	if (value.fields.length > 16) fail()
	let units = 0
	const fieldIds = new Set<string>()
	const fields: CanvasFieldValue[] = value.fields.map(value => {
		if (
			!record(value) ||
			Object.keys(value).some(key => !['id', 'value'].includes(key)) ||
			typeof value.id !== 'string' ||
			fieldIds.has(value.id) ||
			!attestedFields.has(value.id) ||
			sourceIds.get(value.id) !== 1 ||
			!(typeof value.value === 'boolean' || (typeof value.value === 'string' && value.value.length <= 4000))
		)
			fail()
		fieldIds.add(value.id)
		units += typeof value.value === 'string' ? value.value.length : 0
		if (units > 16384) fail()
		return { id: value.id, value: value.value }
	})
	const eligible = [...controlIds].filter(id => sourceIds.get(id) === 1)
	if (fields.length !== eligible.length || fields.some(field => !eligible.includes(field.id))) fail()
	return { nodes, fields }
}

/** A synchronous event fence: settlement alone never exposes an older frame. */
export class CanvasFrameGate {
	sequence = 0
	frameSequence = -1
	settledSequence = -1
	retired = false
	fields: CanvasFieldValue[] = []
	get ready(): boolean {
		return !this.retired && this.frameSequence >= this.sequence && this.settledSequence >= this.sequence
	}
	admit(): number {
		if (this.retired) throw new Error('Canvas retired')
		return ++this.sequence
	}
	frame(sequence: number, fields: CanvasFieldValue[]): boolean {
		if (this.retired || sequence < this.sequence || sequence < this.frameSequence || sequence > this.sequence)
			return false
		this.frameSequence = sequence
		this.fields = fields.map(value => ({ ...value }))
		return true
	}
	settle(sequence: number): void {
		if (!this.retired && sequence === this.sequence) this.settledSequence = sequence
	}
	dispose(): void {
		this.retired = true
		this.fields = []
	}
}
