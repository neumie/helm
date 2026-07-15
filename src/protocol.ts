import { HELM_BUILD_ID } from './build-id.generated.js'

/**
 * Desktop-app ↔ daemon wire contract revision.
 *
 * Bump this whenever an app-visible status, field, or lifecycle behavior changes,
 * and update app/src/protocol-version.ts in the same slice. The app uses it to restart a
 * stale launchd daemon before consuming incompatible responses.
 */
export const DAEMON_PROTOCOL_VERSION = 25
export const DAEMON_BUILD_ID = HELM_BUILD_ID
