// Storybook (Vite) bundles the worker from its source. The app build swaps this module for
// data-worker-factory.built.ts (app/build.mjs), which points at the built file served by helm-viewer:.
export const createDataWorker = () => new Worker(new URL('./data-worker.ts', import.meta.url), { type: 'module' })
