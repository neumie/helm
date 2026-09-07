import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { z } from 'zod'

export const remoteEnrollmentFileSchema = z
	.object({
		protocol: z.literal(1),
		enrollmentId: z.string().uuid(),
		capability: z.string().regex(/^[\w-]{43}$/),
		scopeId: z.string().uuid().nullable(),
		generation: z.number().int().positive().safe(),
		socketPath: z.string().max(103),
	})
	.strict()
export type RemoteEnrollmentFile = z.infer<typeof remoteEnrollmentFileSchema>

/** Local opt-in only. Browser contracts never accept a path or return this descriptor. */
export function readRemoteEnrollment(path: string): RemoteEnrollmentFile {
	const parent = dirname(resolve(path))
	const directory = lstatSync(parent)
	if (
		!directory.isDirectory() ||
		directory.isSymbolicLink() ||
		directory.uid !== process.getuid?.() ||
		(directory.mode & 0o777) !== 0o700 ||
		realpathSync(parent) !== parent
	)
		throw new Error('Remote enrollment needs a private canonical directory')
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
	try {
		const stat = fstatSync(fd)
		if (
			!stat.isFile() ||
			stat.nlink !== 1 ||
			stat.uid !== process.getuid?.() ||
			(stat.mode & 0o777) !== 0o600 ||
			stat.size > 4096
		)
			throw new Error('Invalid Remote enrollment file')
		const bytes = Buffer.alloc(4097)
		const length = readSync(fd, bytes, 0, bytes.length, 0)
		if (length > 4096) throw new Error('Remote enrollment is too large')
		const value = remoteEnrollmentFileSchema.parse(JSON.parse(bytes.subarray(0, length).toString('utf8')))
		if (value.socketPath !== `${parent}/host.sock`) throw new Error('Remote socket is outside enrollment directory')
		return value
	} finally {
		closeSync(fd)
	}
}
