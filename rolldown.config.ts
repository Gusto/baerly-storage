import { defineConfig } from "rolldown";
import { dts } from "rolldown-plugin-dts";

export default defineConfig({
  input: {
    index: "packages/server/src/index.ts",
    auth: "packages/server/src/auth/index.ts",
    http: "packages/server/src/http/index.ts",
    maintenance: "packages/server/src/maintenance.ts",
    observability: "packages/server/src/observability/index.ts",
  },
  external: [/^node:/, "vitest", "@fast-check/vitest", "@vitest/expect"],
  output: {
    dir: "dist",
    format: "esm",
    sourcemap: true,
  },
  plugins: [dts({ tsgo: true })],
});
