import { defineConfig } from "vitest/config";

// Standalone — `vite.config.ts` loads `@cloudflare/vite-plugin`, which
// rejects vitest's pool/environment combo. Add `@cloudflare/vitest-pool-workers`
// here if you want Worker-side integration tests.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}", "*.test.ts"],
  },
});
