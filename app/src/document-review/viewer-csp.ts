// The viewer page's Content-Security-Policy, sent as a response header on every helm-viewer://app response
// (workers take their CSP from their own response, not the page). Dependency-free: the built-entry browser test
// imports it to serve the same header. docs/plans/helm-open/spec.md, Renderer isolation. `worker-src` keeps
// `blob:` because the JSX/TSX canvas runs its compiled component in a blob worker (feedback mode only).
export const VIEWER_CSP = [
	"default-src 'none'",
	"script-src 'self' 'wasm-unsafe-eval'",
	"worker-src 'self' blob:",
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' blob: data:",
	"media-src 'self'",
	"font-src 'self' data:",
	"connect-src 'self'",
	"frame-src 'self'",
	"base-uri 'none'",
	"form-action 'none'",
	"object-src 'none'",
].join('; ')

/** File bytes are inert: never a document, script or worker, whatever they contain. */
export const VIEWER_FILE_CSP = "sandbox; default-src 'none'"
