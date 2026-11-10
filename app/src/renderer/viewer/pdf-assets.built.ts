// The app build's pdf.js assets: assets/pdfjs/ next to the chunk that imports this, served by helm-viewer: with the
// viewer CSP header (the build replaces pdf-assets.ts with this file and copies the assets there).
export const pdfAssetBase = () => new URL('./pdfjs/', import.meta.url).href
