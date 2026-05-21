import { defineConfig } from "vitest/config";

// Standalone — `vite.config.ts` loads `@cloudflare/vite-plugin`, which
// rejects vitest's pool/environment combo at runtime (`The following
// environment options are incompatible with the Cloudflare Vite
// plugin`). Keeping this config separate means vitest never touches
// the Worker dev pipeline. For Worker-side integration tests, add
// `@cloudflare/vitest-pool-workers` and a `test.poolOptions.workers`
// project alongside this one.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}", "*.test.ts"],
  },
});
