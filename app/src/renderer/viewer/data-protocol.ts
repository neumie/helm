// Messages between the data view and its worker. The worker keeps the parsed value; the window asks for rows.
import type { DataLanguage } from '../../../../src/document-review/formats'
import type { DataRow, NodeKind } from './data-model'

export type DataRequest =
	| { id: number; type: 'open'; text: string; language: DataLanguage }
	| { id: number; type: 'rows'; expanded: string[] }
	| { id: number; type: 'search'; query: string }
	| { id: number; type: 'copy'; pointer: string }

export type DataResponse =
	| { id: number; type: 'opened'; error: string | null; kind: NodeKind; count: number }
	| { id: number; type: 'rows'; rows: DataRow[]; truncated: boolean }
	| { id: number; type: 'search'; matches: string[]; truncated: boolean }
	| { id: number; type: 'copy'; text: string | null }
	| { id: number; type: 'failed'; error: string }
