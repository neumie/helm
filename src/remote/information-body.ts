import { INFORMATION_PUBLISH_BYTES } from './information-protocol.js'

/** Independently count actual bytes, even when Content-Length claims a smaller body. */
export async function readInformationBody(request: Request): Promise<{ value: unknown } | { error: 400 | 413 }> {
	const declared = request.headers.get('Content-Length')
	if (declared && (!/^\d+$/.test(declared) || Number(declared) > INFORMATION_PUBLISH_BYTES)) return { error: 413 }
	if (!request.body || request.signal.aborted) return { error: 400 }
	const reader = request.body.getReader()
	let rejectWait: () => void = () => {}
	const stopped = new Promise<never>((_resolve, reject) => {
		rejectWait = () => reject(new Error('information_body_stopped'))
	})
	const timer = setTimeout(rejectWait, 2000)
	timer.unref()
	request.signal.addEventListener('abort', rejectWait, { once: true })
	const chunks: Uint8Array[] = []
	let size = 0
	try {
		for (;;) {
			const { done, value } = await Promise.race([reader.read(), stopped])
			if (request.signal.aborted) return { error: 400 }
			if (done) break
			size += value.byteLength
			if (size > INFORMATION_PUBLISH_BYTES) return { error: 413 }
			chunks.push(value)
		}
		if (declared !== null && Number(declared) !== size) return { error: 400 }
		return { value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) }
	} catch {
		return { error: 400 }
	} finally {
		clearTimeout(timer)
		request.signal.removeEventListener('abort', rejectWait)
		// Do not cancel the Node request stream before writing the rejection: that
		// destroys its socket and races Hono's response write. The adapter owns drain.
		reader.releaseLock()
	}
}
