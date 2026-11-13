import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { readRendererCss } from './helpers/renderer-css'

const css = readRendererCss()
const buttonCss = readFileSync(new URL('../app/src/renderer/button.css', import.meta.url), 'utf8')
const toast = readFileSync(new URL('../app/src/renderer/toast.ts', import.meta.url), 'utf8')
const button = readFileSync(new URL('../app/src/renderer/button.tsx', import.meta.url), 'utf8')
const iconButton = readFileSync(new URL('../app/src/renderer/icon-button.tsx', import.meta.url), 'utf8')
const sidebarUi = readFileSync(new URL('../app/src/renderer/sidebar/ui.tsx', import.meta.url), 'utf8')
const renderer = readFileSync(new URL('../app/src/renderer/terminal-workspace.ts', import.meta.url), 'utf8')
const story = readFileSync(new URL('../app/src/renderer/Toast.stories.tsx', import.meta.url), 'utf8')

test('toasts render as compact bottom-right notices', () => {
	assert.match(css, /#toasts\s*\{[^}]*right:\s*12px[^}]*bottom:\s*12px/s)
	assert.match(css, /#toasts\s*\{[^}]*width:\s*min\(320px, calc\(100vw - 32px\)\)/s)
	assert.match(css, /#toasts\s*\{[^}]*pointer-events:\s*none/s)
	assert.doesNotMatch(css, /#toasts\s*\{[^}]*left:|#toasts\s*\{[^}]*translateX/s)
	assert.match(css, /\.toast\s*\{[^}]*width:\s*100%[^}]*min-height:\s*48px[^}]*padding:\s*11px 12px 13px/s)
	assert.match(css, /\.toast\s*\{[^}]*align-items:\s*flex-start/s)
	assert.match(story, /justifyContent:\s*'flex-end'/)
	assert.match(story, /width:\s*'min\(320px, calc\(100vw - 32px\)\)'/)
})

test('toast hierarchy uses the shared ghost button and inset timer hairline', () => {
	assert.match(css, /\.toast-msg\s*\{[^}]*font-size:\s*13px[^}]*font-weight:\s*500[^}]*line-height:\s*18px/s)
	assert.match(css, /\.toast-detail\s*\{[^}]*color:\s*var\(--text-2\)[^}]*font-size:\s*11px/s)
	assert.match(css, /\.toast-action\s*\{[^}]*flex:\s*none[^}]*margin:\s*-3px 0 0 0/s)
	assert.match(css, /\.toast-dismiss\s*\{[^}]*flex:\s*none[^}]*margin:\s*-3px -6px 0 -6px/s)
	assert.doesNotMatch(css, /\.toast-(?:action|dismiss)\s*\{[^}]*(?:height|padding|border|background|color|font-)/s)
	assert.match(css, /\.toast-countdown\s*\{[^}]*left:\s*12px[^}]*right:\s*12px[^}]*bottom:\s*5px[^}]*height:\s*1px/s)
	assert.match(toast, /countdownEl\.style\.transition = `transform \$\{ttl\}ms linear`/)
})

test('toast action uses the renderer-wide Btn primitive through its plain-DOM adapter', () => {
	assert.match(button, /export function Btn\(/)
	assert.match(button, /export function createButton\(/)
	assert.match(sidebarUi, /import \{ Btn \} from '\.\.\/button'/)
	assert.match(sidebarUi, /export \{ Btn, IconBtn \}/)
	assert.match(button, /import '\.\/button\.css'/)
	assert.match(buttonCss, /\.btn-sm\s*\{[^}]*height:\s*24px[^}]*padding:\s*0 10px/s)
	assert.match(toast, /createButton\(\{[\s\S]*tone: 'ghost',[\s\S]*sm: true,[\s\S]*className: 'toast-action'/)
	assert.match(iconButton, /export function createIconButton\(/)
	assert.match(
		toast,
		/createIconButton\(\{[\s\S]*label: 'Dismiss notification',[\s\S]*glyph: '×',[\s\S]*className: 'toast-dismiss',[\s\S]*onClick: dismiss/,
	)
	assert.doesNotMatch(toast, /document\.createElement\('button'\)/)
	assert.match(story, /<Btn tone="ghost" sm className="toast-action">/)
	assert.match(story, /<IconBtn label="Dismiss notification" className="toast-dismiss">/)
})

test('terminal close notices always name the terminal in one line', () => {
	assert.equal([...renderer.matchAll(/message: `\$\{shown\} closed`/g)].length, 2)
	assert.doesNotMatch(renderer, /message: 'Terminal closed'|message: 'Background terminal closed'|shown === 'zsh'/)
	assert.match(css, /\.toast-msg\s*\{[^}]*text-overflow:\s*ellipsis[^}]*white-space:\s*nowrap/s)
	assert.match(story, /message="deploy watch closed" action="Undo"/)
})

test('toast accessibility and Undo semantics remain intact', () => {
	assert.match(toast, /container\.setAttribute\('role', 'status'\)/)
	assert.match(toast, /container\.setAttribute\('aria-live', 'polite'\)/)
	assert.match(toast, /options\.action\?\.onClick\(\)/)
	assert.match(toast, /ttlTimer = window\.setTimeout\(dismiss, ttl\)/)
	assert.match(toast, /if \(ttlTimer !== null\) clearTimeout\(ttlTimer\)/)
	assert.match(toast, /onClick: dismiss/)
})

// §3.6, §9 ruling 29 (D14 C, Jakub 2026-11-13): no visible-toast cap. toast.ts removes a notice only by its TTL,
// its × or its action, never to make room, so an Undo toast stays its whole grace however many notices follow.
// Runs the real toast.ts (bundled with esbuild, CSS and React stubbed) against a minimal DOM and a fake clock.
interface FakeNode {
	className: string
	children: FakeNode[]
	parent: FakeNode | null
	textContent: string
	style: Record<string, string>
	click(): void
}
type ToastModule = {
	showToast(options: { message: string; action?: { label: string; onClick: () => void }; ttlMs?: number }): {
		dismiss(): void
	}
}

async function loadToast(): Promise<{ toast: ToastModule; dom: FakeDom; clock: FakeClock; cleanup(): Promise<void> }> {
	const { createRequire } = await import('node:module')
	const { mkdtemp, rm } = await import('node:fs/promises')
	const { tmpdir } = await import('node:os')
	const { join, resolve } = await import('node:path')
	const dir = await mkdtemp(join(tmpdir(), 'helm-toast-'))
	const esbuild = createRequire(resolve('app/package.json'))('esbuild')
	await esbuild.build({
		entryPoints: [resolve('app/src/renderer/toast.ts')],
		outfile: join(dir, 'toast.cjs'),
		bundle: true,
		platform: 'node',
		format: 'cjs',
		jsx: 'automatic',
		loader: { '.css': 'empty' },
		plugins: [
			{
				name: 'stub-react',
				setup(build: {
					onResolve(o: { filter: RegExp }, f: () => { path: string; namespace: string }): void
					onLoad(o: { filter: RegExp; namespace: string }, f: () => { contents: string; loader: string }): void
				}) {
					build.onResolve({ filter: /^react(\/.*)?$/ }, () => ({ path: 'react', namespace: 'stub-react' }))
					build.onLoad({ filter: /.*/, namespace: 'stub-react' }, () => ({
						contents: 'export const jsx = () => null; export const jsxs = jsx; export const Fragment = null;',
						loader: 'js',
					}))
				},
			},
		],
	})
	const dom = new FakeDom()
	const clock = new FakeClock()
	const globals = globalThis as unknown as Record<string, unknown>
	const saved = ['document', 'window', 'setTimeout', 'clearTimeout', 'requestAnimationFrame'].map(
		key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
	)
	const define = (key: string, value: unknown) =>
		Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
	define('document', dom)
	define('setTimeout', (fn: () => void, ms = 0) => clock.add(fn, ms))
	define('clearTimeout', (id: number) => clock.cancel(id))
	define('requestAnimationFrame', (fn: () => void) => clock.add(fn, 16))
	define('window', globals)
	const toast = createRequire(import.meta.url)(join(dir, 'toast.cjs')) as ToastModule
	return {
		toast,
		dom,
		clock,
		async cleanup() {
			for (const [key, descriptor] of saved) {
				if (descriptor) Object.defineProperty(globalThis, key, descriptor)
				else Reflect.deleteProperty(globalThis, key)
			}
			await rm(dir, { recursive: true, force: true })
		},
	}
}

class FakeClock {
	now = 0
	private next = 1
	private timers = new Map<number, { at: number; fn: () => void }>()
	add(fn: () => void, ms: number): number {
		const id = this.next++
		this.timers.set(id, { at: this.now + ms, fn })
		return id
	}
	cancel(id: number): void {
		this.timers.delete(id)
	}
	advance(ms: number): void {
		const end = this.now + ms
		for (;;) {
			const due = [...this.timers.entries()]
				.filter(([, t]) => t.at <= end)
				.sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
			if (!due) break
			this.timers.delete(due[0])
			this.now = due[1].at
			due[1].fn()
		}
		this.now = end
	}
}

class FakeElement implements FakeNode {
	className = ''
	children: FakeElement[] = []
	parent: FakeElement | null = null
	textContent = ''
	style: Record<string, string> = {}
	id = ''
	type = ''
	title = ''
	disabled = false
	private attributes = new Map<string, string>()
	private listeners: ((event: { stopPropagation(): void }) => void)[] = []
	constructor(readonly tag: string) {}
	get classList() {
		const names = () => this.className.split(/\s+/).filter(Boolean)
		return {
			add: (name: string) => {
				if (!names().includes(name)) this.className = [...names(), name].join(' ')
			},
			remove: (name: string) => {
				this.className = names()
					.filter(n => n !== name)
					.join(' ')
			},
			contains: (name: string) => names().includes(name),
		}
	}
	get isConnected(): boolean {
		return this.parent === null ? this.tag === 'body' : this.parent.isConnected
	}
	setAttribute(name: string, value: string): void {
		this.attributes.set(name, value)
	}
	getAttribute(name: string): string | null {
		return this.attributes.get(name) ?? null
	}
	appendChild(child: FakeElement): FakeElement {
		child.remove()
		child.parent = this
		this.children.push(child)
		return child
	}
	append(...nodes: FakeElement[]): void {
		for (const node of nodes) this.appendChild(node)
	}
	insertBefore(child: FakeElement, ref: FakeElement): FakeElement {
		child.remove()
		child.parent = this
		this.children.splice(this.children.indexOf(ref), 0, child)
		return child
	}
	remove(): void {
		if (!this.parent) return
		this.parent.children.splice(this.parent.children.indexOf(this), 1)
		this.parent = null
	}
	addEventListener(type: string, fn: (event: { stopPropagation(): void }) => void): void {
		if (type === 'click') this.listeners.push(fn)
	}
	click(): void {
		for (const fn of this.listeners) fn({ stopPropagation() {} })
	}
	find(className: string): FakeElement | undefined {
		for (const child of this.children) {
			if (child.classList.contains(className)) return child
			const deep = child.find(className)
			if (deep) return deep
		}
		return undefined
	}
}

class FakeDom {
	body = new FakeElement('body')
	createElement(tag: string): FakeElement {
		return new FakeElement(tag)
	}
	get toasts(): FakeElement[] {
		return this.body.children.find(child => child.id === 'toasts')?.children ?? []
	}
	messages(): string[] {
		return this.toasts.map(toast => toast.find('toast-msg')?.textContent ?? '')
	}
}

const EXIT = 160 // toast.ts EXIT_MS: the leave transition before removal

test('toast.ts never caps the stack: six notices in a row all stay until their own TTL', async () => {
	const { toast, dom, clock, cleanup } = await loadToast()
	try {
		const undo = () => ({ label: 'Undo', onClick: () => {} })
		const batch = [
			{ message: 'Settings applied' },
			{ message: 'Moved to Background in Work' },
			{ message: 'deploy watch closed', action: undo(), ttlMs: 15_000 },
			{ message: 'api logs closed', action: undo(), ttlMs: 15_000 },
			{ message: 'zsh closed', action: undo(), ttlMs: 15_000 },
			{ message: 'Terminal folder updated' },
		]
		for (const [index, options] of batch.entries()) {
			if (index > 0) clock.advance(400)
			toast.showToast(options)
		}
		// The sixth notice arrives at 2000ms; the first TTL ends at 4000ms.
		clock.advance(4000 - 1 - clock.now)
		assert.deepEqual(
			dom.messages(),
			batch.map(options => options.message),
		)
		assert.ok(dom.toasts.every(el => el.classList.contains('shown') && !el.classList.contains('leaving')))
		// Each plain notice leaves at its own 4000ms TTL, oldest first, nothing earlier.
		clock.advance(1 + EXIT)
		assert.deepEqual(
			dom.messages(),
			batch.slice(1).map(options => options.message),
		)
		clock.advance(6000 + EXIT - clock.now) // the last plain notice (shown at 2000ms) has left too
		assert.deepEqual(dom.messages(), ['deploy watch closed', 'api logs closed', 'zsh closed'])
		// Twelve more notices later, the first Undo is still there one millisecond before its 15s grace ends.
		for (let index = 0; index < 12; index += 1) toast.showToast({ message: `Notice ${index}`, ttlMs: 60_000 })
		clock.advance(800 + 15_000 - 1 - clock.now)
		assert.equal(dom.messages().filter(message => message.endsWith(' closed')).length, 3)
		clock.advance(1 + EXIT)
		assert.deepEqual(
			dom.messages().filter(message => message.endsWith(' closed')),
			['api logs closed', 'zsh closed'],
		)
	} finally {
		await cleanup()
	}
})

test('toast.ts removes a notice early only by its × or by its action dismissing it', async () => {
	const { toast, dom, clock, cleanup } = await loadToast()
	try {
		let undone = 0
		toast.showToast({ message: 'Plain', ttlMs: 60_000 })
		const undo = toast.showToast({
			message: 'deploy watch closed',
			ttlMs: 15_000,
			action: {
				label: 'Undo',
				onClick: () => {
					undone += 1
					undo.dismiss()
				},
			},
		})
		toast.showToast({ message: 'Third', ttlMs: 60_000 })
		clock.advance(100)
		dom.toasts[0]?.find('toast-dismiss')?.click()
		clock.advance(EXIT)
		assert.deepEqual(dom.messages(), ['deploy watch closed', 'Third'])
		dom.toasts[0]?.find('toast-action')?.click()
		clock.advance(EXIT)
		assert.equal(undone, 1)
		assert.deepEqual(dom.messages(), ['Third'])
	} finally {
		await cleanup()
	}
})
