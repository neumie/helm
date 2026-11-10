// The renderer registry the spec proposes (spec §Architecture): one entry per format family.
// Story-only here; the production registry would also carry admission limits and capabilities.
import type { ComponentType } from 'react'
import { CodeView } from './CodeView'
import { DocxView } from './DocxView'
import { ImageView } from './ImageView'
import { JsonView } from './JsonView'
import { MarkdownView } from './MarkdownView'
import { PdfView } from './PdfView'
import { SheetView } from './SheetView'
import type { RendererProps, ViewerFormat } from './types'

export const RENDERERS: Partial<Record<ViewerFormat, ComponentType<RendererProps>>> = {
	pdf: PdfView,
	image: ImageView,
	sheet: SheetView,
	csv: SheetView,
	docx: DocxView,
	json: JsonView,
	code: CodeView,
	markdown: MarkdownView,
}
