import type { SolverResult } from '../types.js'

/** Comment for a `complex` result: a partial solution pushed to a branch. */
export function partialSolutionComment(result: SolverResult, branchName: string): string {
	let md = `**Vigil**: Partial solution on branch \`${branchName}\`.\n\n`
	md += `**Summary**: ${result.summary}\n\n`
	if (result.analysis) md += `**Analysis**:\n${result.analysis}\n\n`
	if (result.remainingWork?.length) {
		md += '**Remaining work**:\n'
		for (const item of result.remainingWork) md += `- ${item}\n`
	}
	return md
}

/** Comment for an `unclear` result: questions for the requester. */
export function clarificationComment(result: SolverResult): string {
	let md = '**Vigil**: Cannot proceed — task needs clarification.\n\n'
	if (result.analysis) md += `**Analysis**:\n${result.analysis}\n\n`
	if (result.questionsForRequester?.length) {
		md += '**Questions**:\n'
		for (const q of result.questionsForRequester) md += `- ${q}\n`
	}
	return md
}
