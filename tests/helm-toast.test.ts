import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const css = readFileSync(new URL('../app/src/renderer/styles.css', import.meta.url), 'utf8')
const buttonCss = readFileSync(new URL('../app/src/renderer/button.css', import.meta.url), 'utf8')
const toast = readFileSync(new URL('../app/src/renderer/toast.ts', import.meta.url), 'utf8')
const button = readFileSync(new URL('../app/src/renderer/button.tsx', import.meta.url), 'utf8')
const sidebarUi = readFileSync(new URL('../app/src/renderer/sidebar/ui.tsx', import.meta.url), 'utf8')
const renderer = readFileSync(new URL('../app/src/renderer/renderer.ts', import.meta.url), 'utf8')
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
	assert.match(css, /\.toast-action\s*\{[^}]*flex:\s*none[^}]*margin:\s*-3px -6px 0 0/s)
	assert.doesNotMatch(css, /\.toast-action\s*\{[^}]*(?:height|padding|border|background|color|font-)/s)
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
	assert.doesNotMatch(toast, /document\.createElement\('button'\)/)
	assert.match(story, /<Btn tone="ghost" sm className="toast-action">/)
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
})
