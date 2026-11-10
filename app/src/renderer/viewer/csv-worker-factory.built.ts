// The app build's CSV worker: assets/csv-worker.js next to the chunk that imports this, served by helm-viewer: with
// the viewer CSP header (the build replaces csv-worker-factory.ts with this file).
export const createCsvWorker = () => new Worker(new URL('./csv-worker.js', import.meta.url), { type: 'module' })
