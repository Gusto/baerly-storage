import { defineConfig } from "rolldown";
import { dts } from "rolldown-plugin-dts";

export default defineConfig({
  input: "packages/server/src/index.ts",
  external: ["vitest", "@fast-check/vitest", "@vitest/expect"],
  output: {
    dir: "dist",
    format: "esm",
    sourcemap: true,
  },
  plugins: [dts({ tsgo: true })],
});
