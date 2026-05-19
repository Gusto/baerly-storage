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
    export: "packages/export/src/index.ts",
  },
  external: [
    /^node:/,
    "@cloudflare/workers-types",
    "@fast-check/vitest",
    "@vitest/expect",
    "@xmldom/xmldom",
    "aws4fetch",
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
