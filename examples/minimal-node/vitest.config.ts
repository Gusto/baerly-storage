import { defineConfig } from "vitest/config";

// Standalone so vitest doesn't pick up `vite.config.ts` and try to
// resolve its plugins. Node environment matches where this scaffold's
// code runs — set `environment: "happy-dom"` for browser-side tests
// (already in devDependencies).
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}", "*.test.ts"],
  },
});
