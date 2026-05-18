import { defineConfig } from "rolldown";

export default defineConfig({
  input: "src/baerly.ts",
  external: [/^node:/, "aws4fetch", "@xmldom/xmldom"],
  output: {
    dir: "../../dist",
    entryFileNames: "baerly.js",
    format: "esm",
    sourcemap: true,
    banner: "#!/usr/bin/env node",
  },
});
