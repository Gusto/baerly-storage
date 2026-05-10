import { configDefaults, defineConfig } from "vitest/config";

// `conformance.test.ts` requires gitignored credentials files
// (`credentials/*.json`) and a live Minio. Excluded by default;
// opt in with `CONFORMANCE=1 pnpm test` (or `pnpm test:conformance`).
const conformanceExclude =
    process.env.CONFORMANCE === "1" ? [] : ["**/conformance.test.ts"];

export default defineConfig({
    test: {
        include: [
            "src/**/*.test.ts",
            "tests/**/*.test.ts",
            "packages/*/src/**/*.test.ts",
        ],
        exclude: [...configDefaults.exclude, ...conformanceExclude],
        setupFiles: ["tests/setup/fast-check.ts"],
        // Process isolation. Vitest 4's default `pool: 'threads'` with
        // `isolate: true` rebuilds the module graph for every test file
        // inside a worker thread; the per-file setup overhead starves
        // `randomized.test.ts`'s tight 5ms polling loop when the suite
        // grows. Forks have process-level isolation with no rebuild
        // overhead per file, and the wall-clock cost of forking is
        // amortized across the suite's reload time.
        pool: "forks",
        // Uint8Array.{toBase64,fromBase64} are TC39 Stage 4 but still gated
        // behind --js-base-64 in current V8 (Node 24 / V8 13.6). Drop this
        // once Node ships the methods unflagged.
        execArgv: ["--js-base-64"],
        coverage: {
            provider: "v8",
            include: ["src/**", "packages/*/src/**"],
            exclude: ["**/*.test.ts", "**/dist/**"],
            reporter: ["text", "html"],
        },
    },
});
