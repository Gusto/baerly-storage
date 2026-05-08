import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["src/**/*.test.ts"],
        // Uint8Array.{toBase64,fromBase64} are TC39 Stage 4 but still gated
        // behind --js-base-64 in current V8 (Node 24 / V8 13.6). Drop this
        // once Node ships the methods unflagged.
        execArgv: ["--js-base-64"],
    },
});
