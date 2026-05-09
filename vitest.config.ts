import { configDefaults, defineConfig } from "vitest/config";

// `conformance.test.ts` requires gitignored credentials files
// (`credentials/*.json`) and a live Minio. Excluded by default;
// opt in with `CONFORMANCE=1 pnpm test` (or `pnpm test:conformance`).
const conformanceExclude =
    process.env.CONFORMANCE === "1" ? [] : ["**/conformance.test.ts"];

export default defineConfig({
    test: {
        include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
        exclude: [...configDefaults.exclude, ...conformanceExclude],
        // Uint8Array.{toBase64,fromBase64} are TC39 Stage 4 but still gated
        // behind --js-base-64 in current V8 (Node 24 / V8 13.6). Drop this
        // once Node ships the methods unflagged.
        execArgv: ["--js-base-64"],
    },
});
