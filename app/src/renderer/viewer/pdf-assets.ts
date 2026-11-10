// Storybook (Vite) serves pdfjs-dist at /pdfjs/ (app/.storybook/main.ts staticDirs). The app build swaps this module
// for pdf-assets.built.ts (app/build.mjs), which points at the copies served by helm-viewer: from dist/viewer/assets.
export const pdfAssetBase = () => new URL('/pdfjs/', window.location.href).href
