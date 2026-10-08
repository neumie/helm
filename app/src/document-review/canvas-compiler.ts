import ts from 'typescript'
import type { CanvasSourceBlock, ReviewCanvasCompilation } from '../../../src/document-review/canvas-types.js'

/** Parse/transpile only: document code is never executed by the native host. */
export function compileReviewCanvas(source: string): ReviewCanvasCompilation {
	const fail = (error: string): ReviewCanvasCompilation => ({ code: null, blocks: [], fieldIds: [], error })
	try {
		if (Buffer.byteLength(source, 'utf8') > 512 * 1024) return fail('Canvas source exceeds 512KiB')
		const file = ts.createSourceFile('canvas.tsx', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX)
		// TypeScript 5.9 owns directive recognition; strings/prose must not become a substring ban.
		const pragmas: unknown = Object.getOwnPropertyDescriptor(file, 'pragmas')?.value
		if (!(pragmas instanceof Map)) return fail('Canvas compiler pragma metadata unavailable')
		if (['jsx', 'jsxfrag', 'jsxruntime', 'jsximportsource'].some(name => pragmas.has(name)))
			return fail('Custom JSX compilation pragmas are unsupported')
		const candidates = new Map<string, CanvasSourceBlock[]>()
		const fields = new Set<string>()
		const intrinsicCalls = new Map<string, string>()
		let error: string | null = null
		let hasDefault = false
		function visit(node: ts.Node): void {
			if (ts.isIdentifier(node) && node.text.startsWith('__helm')) error = 'Canvas source uses a reserved identifier'
			if (ts.isImportDeclaration(node)) {
				if (!ts.isStringLiteral(node.moduleSpecifier) || node.moduleSpecifier.text !== 'react')
					error = 'Only React imports are supported'
			}
			if (ts.isImportEqualsDeclaration(node) || (ts.isExportDeclaration(node) && node.moduleSpecifier))
				error = 'Module loading is unsupported'
			if (ts.isExportAssignment(node) && !node.isExportEquals) hasDefault = true
			if (ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(m => m.kind === ts.SyntaxKind.DefaultKeyword))
				hasDefault = true
			if (
				ts.isCallExpression(node) &&
				(node.expression.kind === ts.SyntaxKind.ImportKeyword ||
					(ts.isIdentifier(node.expression) && ['require', 'eval'].includes(node.expression.text)))
			)
				error = 'Dynamic module loading is unsupported'
			if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
				const opening = ts.isJsxElement(node) ? node.openingElement : node
				const ids = opening.attributes.properties.filter(p => ts.isJsxAttribute(p) && p.name.getText(file) === 'id')
				const attr = ids.length === 1 ? ids[0] : undefined
				if (
					!opening.attributes.properties.some(ts.isJsxSpreadAttribute) &&
					attr &&
					ts.isJsxAttribute(attr) &&
					attr.initializer &&
					ts.isStringLiteral(attr.initializer)
				) {
					const id = attr.initializer.text
					if (
						id.length > 0 &&
						id.length <= 80 &&
						!Array.from(id).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
					) {
						const block = { id, start: node.getStart(file), end: node.end }
						candidates.set(id, [...(candidates.get(id) ?? []), block])
						const tag = opening.tagName.getText(file)
						if (ts.isIdentifier(opening.tagName) && /^[a-z][a-z0-9-]*$/.test(tag))
							intrinsicCalls.set(`${node.pos}:${node.end}`, id)
						const typeAttr = opening.attributes.properties.find(
							p => ts.isJsxAttribute(p) && p.name.getText(file) === 'type',
						)
						const inputType =
							typeAttr &&
							ts.isJsxAttribute(typeAttr) &&
							typeAttr.initializer &&
							ts.isStringLiteral(typeAttr.initializer)
								? typeAttr.initializer.text
								: typeAttr
									? null
									: 'text'
						const multiple = opening.attributes.properties.find(
							p => ts.isJsxAttribute(p) && p.name.getText(file) === 'multiple',
						)
						const singleSelect =
							!multiple ||
							(ts.isJsxAttribute(multiple) &&
								multiple.initializer &&
								ts.isJsxExpression(multiple.initializer) &&
								multiple.initializer.expression?.kind === ts.SyntaxKind.FalseKeyword)
						if (
							tag === 'textarea' ||
							(tag === 'select' && singleSelect) ||
							(tag === 'input' &&
								inputType !== null &&
								['text', 'number', 'checkbox', 'radio', 'email'].includes(inputType))
						)
							fields.add(id)
					}
				}
			}
			ts.forEachChild(node, visit)
		}
		visit(file)
		if (error) return fail(error)
		if (!hasDefault) return fail('Default-export a React component')
		const blocks = [...candidates.values()].filter(list => list.length === 1).map(list => list[0] as CanvasSourceBlock)
		if (blocks.length > 64) return fail('Canvas exceeds 64 source blocks')
		const eligibleIds = new Set(blocks.map(block => block.id))
		// JSX lowering retains the source node range. Only compiler-generated private factory calls may be stamped.
		const attest: ts.TransformerFactory<ts.SourceFile> = context => {
			const visitCall: ts.Visitor = node => {
				const updated = ts.visitEachChild(node, visitCall, context)
				const id = intrinsicCalls.get(`${node.pos}:${node.end}`)
				if (
					id &&
					eligibleIds.has(id) &&
					ts.isCallExpression(updated) &&
					ts.isPropertyAccessExpression(updated.expression) &&
					ts.isIdentifier(updated.expression.expression) &&
					updated.expression.expression.text === '__helmCanvasRuntime' &&
					updated.expression.name.text === 'createElement'
				) {
					return context.factory.createCallExpression(
						context.factory.createPropertyAccessExpression(
							context.factory.createIdentifier('__helmCanvasRuntime'),
							'attest',
						),
						undefined,
						[context.factory.createStringLiteral(id), updated],
					)
				}
				return updated
			}
			return file => ts.visitNode(file, visitCall) as ts.SourceFile
		}
		const result = ts.transpileModule(source, {
			transformers: { after: [attest] },
			fileName: 'canvas.tsx',
			reportDiagnostics: true,
			compilerOptions: {
				target: ts.ScriptTarget.ES2022,
				module: ts.ModuleKind.CommonJS,
				jsx: ts.JsxEmit.React,
				jsxFactory: '__helmCanvasRuntime.createElement',
				jsxFragmentFactory: '__helmCanvasRuntime.Fragment',
				esModuleInterop: true,
				isolatedModules: true,
			},
		})
		if (result.diagnostics?.some(d => d.category === ts.DiagnosticCategory.Error)) return fail('Invalid JSX/TSX source')
		// Classic JSX keeps the resolver contract React-only without a jsx-runtime import.
		return {
			code: result.outputText,
			blocks,
			fieldIds: blocks.filter(b => fields.has(b.id)).map(b => b.id),
			error: null,
		}
	} catch {
		return fail('Invalid or excessively complex JSX/TSX source')
	}
}
