import { defineConfig } from "rolldown";
import { createRollupLicensePlugin } from "rollup-license-plugin";
import { licensePluginOptions, PARTIAL_CLI_FILENAME } from "../../scripts/third-party-licenses.mjs";

export default defineConfig({
  input: "src/baerly.ts",
  // `aws4fetch` and `@rgrove/parse-xml` are bundled into `baerly-storage`
  // (the library import surface). Scaffolded apps install only
  // `baerly-storage`, so the CLI bin can't rely on those packages
  // being on disk — bundle them into the bin instead.
  external: [/^node:/],
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
  // Writes the CLI bin's partial third-party-licenses manifest into
  // `dist/` (output dir is `../../dist`). `pnpm build`'s final step
  // merges it with the library build's partial. See
  // scripts/third-party-licenses.mjs.
  plugins: [createRollupLicensePlugin(licensePluginOptions(PARTIAL_CLI_FILENAME))],
});
