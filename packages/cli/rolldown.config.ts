import { defineConfig } from "rolldown";

export default defineConfig({
  input: "src/baerly.ts",
  external: ["aws4fetch", "@xmldom/xmldom"],
  output: {
    file: "dist/baerly.js",
    format: "esm",
    sourcemap: true,
    banner: "#!/usr/bin/env node",
  },
});
