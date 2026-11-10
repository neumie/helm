// Language id (src/document-review/formats.ts CODE_LANGUAGES) → a lazily imported CodeMirror language, one chunk per
// language pack or legacy mode, so a code window loads only the grammar it shows.
import type { Extension } from '@codemirror/state'

const stream = async (
	load: () => Promise<Parameters<typeof import('@codemirror/language').StreamLanguage.define>[0]>,
) => {
	const [{ StreamLanguage }, mode] = await Promise.all([import('@codemirror/language'), load()])
	return StreamLanguage.define(mode)
}

const LOADERS: Readonly<Record<string, () => Promise<Extension>>> = {
	javascript: () => import('@codemirror/lang-javascript').then(m => m.javascript()),
	jsx: () => import('@codemirror/lang-javascript').then(m => m.javascript({ jsx: true })),
	typescript: () => import('@codemirror/lang-javascript').then(m => m.javascript({ typescript: true })),
	tsx: () => import('@codemirror/lang-javascript').then(m => m.javascript({ typescript: true, jsx: true })),
	json: () => import('@codemirror/lang-json').then(m => m.json()),
	python: () => import('@codemirror/lang-python').then(m => m.python()),
	markdown: () => import('@codemirror/lang-markdown').then(m => m.markdown()),
	css: () => import('@codemirror/lang-css').then(m => m.css()),
	html: () => import('@codemirror/lang-html').then(m => m.html()),
	yaml: () => import('@codemirror/lang-yaml').then(m => m.yaml()),
	jsonl: () => import('@codemirror/lang-json').then(m => m.json()),
	toml: () => stream(() => import('@codemirror/legacy-modes/mode/toml').then(m => m.toml)),
	scss: () => stream(() => import('@codemirror/legacy-modes/mode/css').then(m => m.sCSS)),
	less: () => stream(() => import('@codemirror/legacy-modes/mode/css').then(m => m.less)),
	sass: () => stream(() => import('@codemirror/legacy-modes/mode/sass').then(m => m.sass)),
	xml: () => stream(() => import('@codemirror/legacy-modes/mode/xml').then(m => m.xml)),
	shell: () => stream(() => import('@codemirror/legacy-modes/mode/shell').then(m => m.shell)),
	sql: () => stream(() => import('@codemirror/legacy-modes/mode/sql').then(m => m.standardSQL)),
	go: () => stream(() => import('@codemirror/legacy-modes/mode/go').then(m => m.go)),
	rust: () => stream(() => import('@codemirror/legacy-modes/mode/rust').then(m => m.rust)),
	java: () => stream(() => import('@codemirror/legacy-modes/mode/clike').then(m => m.java)),
	kotlin: () => stream(() => import('@codemirror/legacy-modes/mode/clike').then(m => m.kotlin)),
	scala: () => stream(() => import('@codemirror/legacy-modes/mode/clike').then(m => m.scala)),
	c: () => stream(() => import('@codemirror/legacy-modes/mode/clike').then(m => m.c)),
	cpp: () => stream(() => import('@codemirror/legacy-modes/mode/clike').then(m => m.cpp)),
	csharp: () => stream(() => import('@codemirror/legacy-modes/mode/clike').then(m => m.csharp)),
	objectivec: () => stream(() => import('@codemirror/legacy-modes/mode/clike').then(m => m.objectiveC)),
	dart: () => stream(() => import('@codemirror/legacy-modes/mode/clike').then(m => m.dart)),
	swift: () => stream(() => import('@codemirror/legacy-modes/mode/swift').then(m => m.swift)),
	ruby: () => stream(() => import('@codemirror/legacy-modes/mode/ruby').then(m => m.ruby)),
	lua: () => stream(() => import('@codemirror/legacy-modes/mode/lua').then(m => m.lua)),
	perl: () => stream(() => import('@codemirror/legacy-modes/mode/perl').then(m => m.perl)),
	r: () => stream(() => import('@codemirror/legacy-modes/mode/r').then(m => m.r)),
	haskell: () => stream(() => import('@codemirror/legacy-modes/mode/haskell').then(m => m.haskell)),
	erlang: () => stream(() => import('@codemirror/legacy-modes/mode/erlang').then(m => m.erlang)),
	clojure: () => stream(() => import('@codemirror/legacy-modes/mode/clojure').then(m => m.clojure)),
	groovy: () => stream(() => import('@codemirror/legacy-modes/mode/groovy').then(m => m.groovy)),
	julia: () => stream(() => import('@codemirror/legacy-modes/mode/julia').then(m => m.julia)),
	powershell: () => stream(() => import('@codemirror/legacy-modes/mode/powershell').then(m => m.powerShell)),
	diff: () => stream(() => import('@codemirror/legacy-modes/mode/diff').then(m => m.diff)),
	properties: () => stream(() => import('@codemirror/legacy-modes/mode/properties').then(m => m.properties)),
	dockerfile: () => stream(() => import('@codemirror/legacy-modes/mode/dockerfile').then(m => m.dockerFile)),
	protobuf: () => stream(() => import('@codemirror/legacy-modes/mode/protobuf').then(m => m.protobuf)),
	latex: () => stream(() => import('@codemirror/legacy-modes/mode/stex').then(m => m.stex)),
	cmake: () => stream(() => import('@codemirror/legacy-modes/mode/cmake').then(m => m.cmake)),
	vb: () => stream(() => import('@codemirror/legacy-modes/mode/vb').then(m => m.vb)),
	scheme: () => stream(() => import('@codemirror/legacy-modes/mode/scheme').then(m => m.scheme)),
}

/** The language's highlighting, or null for plain text, an unknown id, or a chunk that failed to load. */
export async function loadLanguage(id: string): Promise<Extension | null> {
	const load = LOADERS[id]
	if (!load) return null
	try {
		return await load()
	} catch {
		return null
	}
}

export const LANGUAGE_WORDS: Readonly<Record<string, string>> = {
	javascript: 'JavaScript',
	jsx: 'JavaScript (JSX)',
	typescript: 'TypeScript',
	tsx: 'TypeScript (TSX)',
	json: 'JSON',
	jsonl: 'JSON Lines',
	yaml: 'YAML',
	toml: 'TOML',
	python: 'Python',
	markdown: 'Markdown',
	css: 'CSS',
	scss: 'SCSS',
	less: 'Less',
	sass: 'Sass',
	html: 'HTML',
	xml: 'XML',
	shell: 'Shell',
	sql: 'SQL',
	go: 'Go',
	rust: 'Rust',
	java: 'Java',
	kotlin: 'Kotlin',
	scala: 'Scala',
	c: 'C',
	cpp: 'C++',
	csharp: 'C#',
	objectivec: 'Objective-C',
	dart: 'Dart',
	swift: 'Swift',
	ruby: 'Ruby',
	lua: 'Lua',
	perl: 'Perl',
	r: 'R',
	haskell: 'Haskell',
	erlang: 'Erlang',
	clojure: 'Clojure',
	groovy: 'Groovy',
	julia: 'Julia',
	powershell: 'PowerShell',
	diff: 'Diff',
	properties: 'Properties',
	dockerfile: 'Dockerfile',
	protobuf: 'Protocol Buffers',
	latex: 'LaTeX',
	cmake: 'CMake',
	vb: 'Visual Basic',
	scheme: 'Scheme',
	plain: 'Plain text',
}
