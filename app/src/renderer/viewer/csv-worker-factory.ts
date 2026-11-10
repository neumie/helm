// Storybook (Vite) bundles the worker from its source. The app build swaps this module for
// csv-worker-factory.built.ts (app/build.mjs), which points at the built file served by helm-viewer:.
export const createCsvWorker = () => new Worker(new URL('./csv-worker.ts', import.meta.url), { type: 'module' })
