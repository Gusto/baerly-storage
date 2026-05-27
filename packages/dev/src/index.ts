export { printDevBanner, type DevBannerOpts, type DevBannerHint } from "./dev-banner.ts";
export { type DevLandingOptions, renderDevLanding } from "./dev-landing.ts";
export * from "./ensure-table.ts";
export * from "./local-fs.ts";

// `baerlyDev` (the Vite plugin) is intentionally NOT re-exported here.
// It pulls the full vite-plugin closure into `dist/dev.js`, which bloats
// the base barrel for consumers that only want `LocalFsStorage` /
// `ensureTable` / `printDevBanner` / `renderDevLanding`. Vite consumers
// import from the dedicated subpath: `@gusto/baerly-storage/dev/vite`.
