// Storybook (Vite) bundles the worker from its source. The app build swaps this module for
// image-worker-factory.built.ts (app/build.mjs), which points at the built file served by helm-viewer:.
export const createImageWorker = () => new Worker(new URL('./image-worker.ts', import.meta.url), { type: 'module' })
