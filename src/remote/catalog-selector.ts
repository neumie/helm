import { REMOTE_CATALOG_LABEL_MAX_LENGTH } from './protocol.js'

/** Bounded JSONL grammar/metadata selector. No message value is accumulated.
 * The fixed-depth grammar stack validates skipped values too. Only top-level
 * metadata strings are retained; display names normalize while decoding.
 */
const MAX_DEPTH = 64
type Frame = { kind: 'object' | 'array'; state: 'keyFirst' | 'key' | 'colon' | 'valueFirst' | 'value' | 'comma' }
type Field = 'type' | 'id' | 'timestamp' | 'parentSession' | 'name'
const fields = new Set<string>(['type', 'id', 'timestamp', 'parentSession', 'name'])
export class SessionSelector {
	private decoder = new TextDecoder('utf-8', { fatal: true })
	private stack: Frame[] = []
	private mode: 'normal' | 'string' | 'escape' | 'unicode' | 'number' | 'literal' = 'normal'
	private unicode = ''
	private numberState = ''
	private literal = ''
	private literalOffset = 0
	private key = ''
	private isKey = false
	private capture?: 'key' | Field
	private text = ''
	private nameFull = false
	private space = false
	private surrogate = ''
	private record: Partial<Record<Field, string>> = {}
	private lineDone = false
	private records = 0
	private header?: { sessionId: string; createdAt: number; hasParent: boolean }
	private name?: string
	private maxDepth = 0
	private maxRetained = 0
	private maxDecodedCharacters = 0
	sessionId?: string

	push(bytes: Uint8Array, overlay: ReadonlySet<string> = new Set()): void {
		const decoded = this.decoder.decode(bytes, { stream: true })
		this.maxDecodedCharacters = Math.max(this.maxDecodedCharacters, decoded.length)
		for (const char of decoded) {
			this.character(char)
			if (this.sessionId && overlay.has(this.sessionId)) return
		}
	}
	finish(): void {
		let tail: string
		try {
			tail = this.decoder.decode()
		} catch {
			throw new Error('incomplete_metadata')
		}
		for (const char of tail) this.character(char)
		if (this.mode !== 'normal' || this.stack.length) throw new Error('incomplete_metadata')
		if (!this.header) throw new Error('unsupported_metadata')
	}
	metadata() {
		return this.header ? { ...this.header, name: this.name } : undefined
	}
	diagnostics() {
		this.retain()
		return { depth: this.maxDepth, retainedCharacters: this.maxRetained, decodedCharacters: this.maxDecodedCharacters }
	}
	private retain(): void {
		this.maxDepth = Math.max(this.maxDepth, this.stack.length)
		const characters =
			this.text.length +
			this.surrogate.length +
			this.unicode.length +
			this.key.length +
			Object.values(this.record).reduce((n, s) => n + s.length, 0) +
			(this.name?.length ?? 0) +
			(this.header?.sessionId.length ?? 0) +
			this.literal.length
		this.maxRetained = Math.max(this.maxRetained, characters)
	}
	private character(char: string): void {
		if (this.mode === 'unicode') {
			if (!/^[\da-f]$/i.test(char)) throw new Error('malformed_metadata')
			this.unicode += char
			if (this.unicode.length === 4) {
				this.append(String.fromCharCode(Number.parseInt(this.unicode, 16)))
				this.unicode = ''
				this.mode = 'string'
			}
			return
		}
		if (this.mode === 'escape') {
			if (char === 'u') {
				this.mode = 'unicode'
				return
			}
			const decoded: Record<string, string> = {
				'"': '"',
				'\\': '\\',
				'/': '/',
				b: '\b',
				f: '\f',
				n: '\n',
				r: '\r',
				t: '\t',
			}
			if (!(char in decoded)) throw new Error('malformed_metadata')
			this.append(decoded[char] ?? '')
			this.mode = 'string'
			return
		}
		if (this.mode === 'string') {
			if (char === '\\') {
				this.mode = 'escape'
				return
			}
			if (char.charCodeAt(0) < 32) throw new Error('malformed_metadata')
			if (char !== '"') {
				this.append(char)
				return
			}
			if (this.surrogate) {
				this.appendNormalized(this.surrogate)
				this.surrogate = ''
			}
			this.mode = 'normal'
			if (this.isKey) {
				this.key = this.text
				const frame = this.stack.at(-1)
				if (!frame) throw new Error('malformed_metadata')
				frame.state = 'colon'
			} else {
				if (this.capture && this.capture !== 'key') this.record[this.capture] = this.text
				this.valueDone()
			}
			this.text = ''
			this.capture = undefined
			return
		}
		if (this.mode === 'literal') {
			if (char !== this.literal[this.literalOffset++]) throw new Error('malformed_metadata')
			if (this.literalOffset === this.literal.length) {
				this.mode = 'normal'
				this.valueDone()
			}
			return
		}
		if (this.mode === 'number') {
			const digit = /^[0-9]$/.test(char)
			const state = this.numberState
			if (state === 'sign' && digit) this.numberState = char === '0' ? 'zero' : 'int'
			else if (state === 'int' && digit) return
			else if ((state === 'int' || state === 'zero') && char === '.') this.numberState = 'dot'
			else if (state === 'dot' && digit) this.numberState = 'fraction'
			else if (state === 'fraction' && digit) return
			else if (['int', 'zero', 'fraction'].includes(state) && /[eE]/.test(char)) this.numberState = 'exp'
			else if (state === 'exp' && /[+-]/.test(char)) this.numberState = 'expSign'
			else if (['exp', 'expSign'].includes(state) && digit) this.numberState = 'expDigits'
			else if (state === 'expDigits' && digit) return
			else {
				if (!['int', 'zero', 'fraction', 'expDigits'].includes(state)) throw new Error('malformed_metadata')
				this.mode = 'normal'
				this.valueDone()
				this.character(char)
			}
			return
		}
		if (char === '\n') {
			if (this.stack.length) throw new Error('malformed_metadata')
			this.lineDone = false
			return
		}
		if (char === ' ' || char === '\t' || char === '\r') return
		if (this.lineDone) throw new Error('malformed_metadata')
		const frame = this.stack.at(-1)
		if (!frame) {
			if (char !== '{') throw new Error('malformed_metadata')
			this.stack.push({ kind: 'object', state: 'keyFirst' })
			this.retain()
			return
		}
		if (frame.state === 'colon') {
			if (char !== ':') throw new Error('malformed_metadata')
			frame.state = 'value'
			return
		}
		if (frame.state === 'comma') {
			if (char === ',') {
				frame.state = frame.kind === 'object' ? 'key' : 'value'
				return
			}
			if (char === (frame.kind === 'object' ? '}' : ']')) {
				this.endContainer()
				return
			}
			throw new Error('malformed_metadata')
		}
		if ((frame.state === 'keyFirst' && char === '}') || (frame.state === 'valueFirst' && char === ']')) {
			this.endContainer()
			return
		}
		this.isKey = frame.state === 'keyFirst' || frame.state === 'key'
		if (this.isKey && char !== '"') throw new Error('malformed_metadata')
		if (char === '"') {
			this.capture = this.isKey
				? this.stack.length === 1
					? 'key'
					: undefined
				: this.stack.length === 1 && fields.has(this.key)
					? (this.key as Field)
					: undefined
			this.text = ''
			this.nameFull = false
			this.space = false
			this.mode = 'string'
			return
		}
		if (this.stack.length === 1 && fields.has(this.key)) delete this.record[this.key as Field]
		// Relevant scalar fields must not masquerade as nested metadata. Null name
		// is the same absent/clear representation used by optional Pi metadata.
		if (this.stack.length === 1 && fields.has(this.key) && !(this.key === 'name' && char === 'n'))
			throw new Error('unsupported_metadata')
		if (char === '{' || char === '[') {
			if (this.stack.length >= MAX_DEPTH) throw new Error('unsupported_metadata')
			this.stack.push({ kind: char === '{' ? 'object' : 'array', state: char === '{' ? 'keyFirst' : 'valueFirst' })
			this.retain()
			return
		}
		if (char === '-' || /^[0-9]$/.test(char)) {
			this.mode = 'number'
			this.numberState = char === '-' ? 'sign' : char === '0' ? 'zero' : 'int'
			return
		}
		if (char === 't' || char === 'f' || char === 'n') {
			this.mode = 'literal'
			this.literal = char === 't' ? 'true' : char === 'f' ? 'false' : 'null'
			this.literalOffset = 1
			return
		}
		throw new Error('malformed_metadata')
	}
	private append(char: string): void {
		if (!this.capture) return
		if (this.surrogate) {
			if (char.length === 1 && /[\udc00-\udfff]/.test(char)) {
				this.appendNormalized(this.surrogate + char)
				this.surrogate = ''
				return
			}
			this.appendNormalized(this.surrogate)
			this.surrogate = ''
		}
		if (char.length === 1 && /[\ud800-\udbff]/.test(char)) {
			this.surrogate = char
			return
		}
		this.appendNormalized(char)
	}
	private appendNormalized(char: string): void {
		if (this.capture !== 'name') {
			// Overlong keys cannot accidentally match a recognized prefix.
			if (this.text.length < 129) {
				this.text += char
				this.retain()
			}
			return
		}
		if (this.nameFull) return
		if (/\s/.test(char) || char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) {
			if (this.text.length) this.space = true
			return
		}
		const addition = this.space ? ` ${char}` : char
		this.space = false
		// Match the wire's UTF-16 bound, preserving the normalized prefix and
		// complete decoded surrogate pairs rather than shearing a final emoji.
		if (this.text.length + addition.length > REMOTE_CATALOG_LABEL_MAX_LENGTH) {
			this.nameFull = true
			return
		}
		this.text += addition
		this.retain()
	}
	private valueDone(): void {
		const frame = this.stack.at(-1)
		if (!frame) throw new Error('malformed_metadata')
		frame.state = 'comma'
	}
	private endContainer(): void {
		this.stack.pop()
		if (this.stack.length) {
			this.valueDone()
			return
		}
		if (this.records++ === 0) {
			const { type, id, timestamp, parentSession } = this.record
			if (
				type !== 'session' ||
				!id ||
				!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ||
				!timestamp ||
				!Number.isFinite(Date.parse(timestamp))
			)
				throw new Error('unsupported_metadata')
			this.header = { sessionId: id, createdAt: Date.parse(timestamp), hasParent: parentSession !== undefined }
			this.sessionId = id
		} else if (this.record.type === 'session') throw new Error('unsupported_metadata')
		else if (!this.record.type) throw new Error('unsupported_metadata')
		else if (this.record.type === 'session_info') this.name = this.record.name || undefined
		this.record = {}
		this.key = ''
		this.lineDone = true
	}
}
