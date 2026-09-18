import { inspectJpegForProcessed } from '../../../../src/remote/image-input-bytes.js'
import type { ImageUploadEnvelope } from '../../../../src/remote/image-input-protocol.js'
import type { RemoteTarget } from '../../../../src/remote/protocol.js'
import { createRemoteFixture } from './remote-fixtures.js'
import { createRemoteTransport } from './transport.js'

/** Opt-in image-capable workbench service. The frozen default Remote fixture remains text-only. */
export function createImageInputFixture() {
	const fixture = createRemoteFixture()
	const uploads: Array<{ owner: { hostEpoch: string; target: RemoteTarget }; bytes: Uint8Array }> = []
	let sequence = 0
	const directory = fixture.transport.directory.bind(fixture.transport)
	const detail = fixture.transport.detail.bind(fixture.transport)
	const send = fixture.transport.send.bind(fixture.transport)
	const imageMessages = new Map<string, number>()
	let imageAvailable = true
	let publishSessions = true
	let workspaceMountSetter: (mounted: boolean) => void = () => {}
	fixture.transport.directory = async (...args) => {
		const value = await directory(...args)
		return {
			...value,
			sessions: publishSessions
				? value.sessions.map(session => ({
						...session,
						imageInput: { version: 1 as const, available: imageAvailable },
					}))
				: [],
		}
	}
	fixture.transport.detail = async (...args) => {
		const value = await detail(...args)
		return {
			...value,
			snapshot: {
				...value.snapshot,
				imageInput: { version: 1, available: imageAvailable },
				messages: value.snapshot.messages.map(message => {
					const count = imageMessages.get(message.id)
					return count
						? {
								...message,
								text: `${message.text}${message.text ? '\n\n' : ''}[${count} ${count === 1 ? 'image' : 'images'} attached]`,
							}
						: message
				}),
			},
		}
	}
	fixture.transport.send = async (...args) => {
		const [command] = args
		if (command.operation.kind === 'prompt' && command.operation.images?.length)
			imageMessages.set(command.commandId, command.operation.images.length)
		return send(...args)
	}
	fixture.transport.uploadImage = async (owner, blob, signal): Promise<ImageUploadEnvelope> => {
		if (signal.aborted) throw signal.reason
		const bytes = new Uint8Array(await blob.arrayBuffer())
		if (signal.aborted) throw signal.reason
		const dimensions = inspectJpegForProcessed(bytes)
		const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)))
		const sha256 = [...digest].map(value => value.toString(16).padStart(2, '0')).join('')
		uploads.push({ owner: structuredClone(owner), bytes })
		sequence++
		return {
			protocol: 1,
			hostEpoch: owner.hostEpoch,
			image: {
				handle: `30000000-0000-4000-8000-${sequence.toString().padStart(12, '0')}`,
				sha256,
				mimeType: 'image/jpeg',
				bytes: bytes.byteLength,
				...dimensions,
			},
		}
	}
	return {
		...fixture,
		uploads,
		useProductionTransport() {
			const production = createRemoteTransport()
			fixture.transport.uploadImage = production.uploadImage
			fixture.transport.send = production.send
			fixture.transport.receipt = production.receipt
		},
		useProductionReads() {
			const production = createRemoteTransport()
			fixture.transport.directory = production.directory
			fixture.transport.detail = production.detail
		},
		setImageAvailable(value: boolean) {
			imageAvailable = value
		},
		prunePublishedSessions() {
			publishSessions = false
		},
		bindWorkspaceMount(setter: (mounted: boolean) => void) {
			workspaceMountSetter = setter
		},
		setWorkspaceMounted(value: boolean) {
			workspaceMountSetter(value)
		},
	}
}

export type ImageInputFixture = ReturnType<typeof createImageInputFixture>
