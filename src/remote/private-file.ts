import { constants, closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
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

/** Registration-only discovery authority. It cannot pair, revoke, or control the host. */
export const remoteRegistrationFileSchema = z
	.object({
		protocol: z.literal(1),
		capability: z.string().regex(/^[\w-]{43}$/),
		socketPath: z.string().max(103),
	})
	.strict()
export type RemoteRegistrationFile = z.infer<typeof remoteRegistrationFileSchema>

/**
 * Reads only bytes attested by one owner-private descriptor. The max+1 read catches
 * growth after fstat; callers never validate a descriptor and reopen its pathname.
 */
export function readOwnerPrivateFile(path: string, maxBytes: number, label: string): string {
	const parent = dirname(resolve(path))
	const directory = lstatSync(parent)
	if (
		!directory.isDirectory() ||
		directory.isSymbolicLink() ||
		directory.uid !== process.getuid?.() ||
		(directory.mode & 0o777) !== 0o700
	)
		throw new Error(`${label} needs a private canonical directory`)
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
	try {
		const stat = fstatSync(fd)
		if (
			!stat.isFile() ||
			stat.nlink !== 1 ||
			stat.uid !== process.getuid?.() ||
			(stat.mode & 0o777) !== 0o600 ||
			stat.size > maxBytes
		)
			throw new Error(`Invalid ${label}`)
		const bytes = Buffer.alloc(maxBytes + 1)
		const length = readSync(fd, bytes, 0, bytes.length, 0)
		if (length > maxBytes) throw new Error(`${label} is too large`)
		return bytes.subarray(0, length).toString('utf8')
	} finally {
		closeSync(fd)
	}
}

/** Local opt-in only. Browser contracts never accept a path or return this descriptor. */
export function readRemoteRegistration(path: string): RemoteRegistrationFile {
	const parent = dirname(resolve(path))
	const value = remoteRegistrationFileSchema.parse(
		JSON.parse(readOwnerPrivateFile(path, 1024, 'Remote registration discovery')),
	)
	if (value.socketPath !== `${parent}/control.sock`)
		throw new Error('Remote registration socket is outside discovery directory')
	return value
}

export function readRemoteEnrollment(path: string): RemoteEnrollmentFile {
	const parent = dirname(resolve(path))
	const value = remoteEnrollmentFileSchema.parse(JSON.parse(readOwnerPrivateFile(path, 4096, 'Remote enrollment')))
	if (value.socketPath !== `${parent}/host.sock`) throw new Error('Remote socket is outside enrollment directory')
	return value
}
