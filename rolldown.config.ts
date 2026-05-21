import { defineConfig } from "rolldown";
import { dts } from "rolldown-plugin-dts";

export default defineConfig({
  input: {
    index: "packages/server/src/index.ts",
    auth: "packages/server/src/auth/index.ts",
    http: "packages/server/src/http/index.ts",
    maintenance: "packages/server/src/maintenance.ts",
    observability: "packages/server/src/observability/index.ts",
    "app-config": "packages/server/src/app-config.ts",
    cloudflare: "packages/adapter-cloudflare/src/index.ts",
    node: "packages/adapter-node/src/index.ts",
    client: "packages/client/src/index.ts",
    "client-react": "packages/client/src/react/index.ts",
    "client-testing": "packages/client/src/testing/index.ts",
    dev: "packages/dev/src/index.ts",
    "dev-vite": "packages/dev/src/vite-plugin.ts",
  },
  // `@xmldom/xmldom` and `aws4fetch` are bundled into the library
  // entries that use them (`dist/node.js` + `dist/dev-vite.js`). They
  // used to be optional peer deps, but pnpm skips optional peers on
  // install, so a fresh `create-baerly` scaffold's `node_modules` had
  // no copy on disk and `vite.config.ts` died on first load with
  // `Cannot find package '@xmldom/xmldom'`. Bundling them in here
  // mirrors `packages/cli/rolldown.config.ts` (the bin) and trades
  // some cold-start bytes for a working scaffold. The
  // `bundle-no-live-import` test in `tests/integration/bundle-size.test.ts`
  // pins this contract across every entry.
  external: [
    /^node:/,
    "@cloudflare/workers-types",
    "@fast-check/vitest",
    "@vitest/expect",
    "react",
    "react-dom",
    "vite",
    "vitest",
  ],
  output: {
    dir: "dist",
    format: "esm",
    sourcemap: true,
  },
  plugins: [dts({ tsgo: true })],
});
