// The app build's image worker: assets/image-worker.js next to the chunk that imports this, served by helm-viewer:
// with the viewer CSP header (the build replaces image-worker-factory.ts with this file).
export const createImageWorker = () => new Worker(new URL('./image-worker.js', import.meta.url), { type: 'module' })
