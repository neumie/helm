import { HELM_BUILD_ID } from './build-id.generated'

/** Copy of src/protocol.ts; update both whenever the daemon wire contract changes. */
export const EXPECTED_DAEMON_PROTOCOL_VERSION = 27
export const EXPECTED_DAEMON_BUILD_ID = HELM_BUILD_ID
