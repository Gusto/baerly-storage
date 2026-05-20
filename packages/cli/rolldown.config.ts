import { defineConfig } from "rolldown";

export default defineConfig({
  input: "src/baerly.ts",
  external: [/^node:/, "aws4fetch", "@xmldom/xmldom"],
  output: {
    dir: "../../dist",
    entryFileNames: "baerly.js",
    format: "esm",
    sourcemap: true,
    // Only the bin entry needs `#!/usr/bin/env node`. Without the
    // chunk-aware guard, dynamic-import chunks (e.g. `logger-pretty-*.js`)
    // get the shebang too — Node treats it as a comment in imported
    // modules but it's a surprising artifact in the published tarball.
    banner: (chunk) => (chunk.isEntry ? "#!/usr/bin/env node" : ""),
  },
});
