import type { Accessor } from 'solid-js'
import { render } from 'solid-js/web'
import { Widget } from './Widget'
import { WIDGET_STYLES } from './widget.styles'

/** Production and workbench mount the same Solid tree in a closed shadow root. */
export function mountWidget(host: HTMLElement, taskId: Accessor<string | null>): () => void {
	const shadow = host.attachShadow({ mode: 'closed' })
	const style = document.createElement('style')
	style.textContent = WIDGET_STYLES
	shadow.appendChild(style)
	const mount = document.createElement('div')
	shadow.appendChild(mount)
	return render(() => <Widget taskId={taskId} />, mount)
}
