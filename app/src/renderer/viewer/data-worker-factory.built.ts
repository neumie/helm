// The app build's data worker: assets/data-worker.js next to the chunk that imports this, served by helm-viewer:
// with the viewer CSP header (the build replaces data-worker-factory.ts with this file).
export const createDataWorker = () => new Worker(new URL('./data-worker.js', import.meta.url), { type: 'module' })
