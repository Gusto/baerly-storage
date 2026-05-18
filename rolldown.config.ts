import { defineConfig } from "rolldown";
import { dts } from "rolldown-plugin-dts";

export default defineConfig({
  input: {
    index: "packages/server/src/index.ts",
    auth: "packages/server/src/auth/index.ts",
    http: "packages/server/src/http/index.ts",
    maintenance: "packages/server/src/maintenance.ts",
    observability: "packages/server/src/observability/index.ts",
    cloudflare: "packages/adapter-cloudflare/src/index.ts",
    node: "packages/adapter-node/src/index.ts",
  },
  external: [
    /^node:/,
    "@cloudflare/workers-types",
    "@fast-check/vitest",
    "@vitest/expect",
    "@xmldom/xmldom",
    "aws4fetch",
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
