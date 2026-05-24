import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";
import { baerlyDevAuth, loadDevVars } from "baerly-storage/dev/vite";

// `.dev.vars` is consumed by the Worker side via @cloudflare/vite-plugin.
// We also load it here so the SPA dev-auth plugin can inject the same
// Bearer token the verifier expects — the secret never enters the SPA
// bundle (this plugin runs only in dev, server-side).
const { SHARED_SECRET } = loadDevVars(".dev.vars", "SHARED_SECRET");

// `prefix` covers `/v1/*` (the baerly cascade) and `/api/*` (the canonical
// namespace for custom Worker routes added via the "wrap `baerly.fetch!`"
// recipe in AGENTS.md). This matches `baerlyDevAuth`'s built-in default —
// it's spelled out here so when you mount under a different prefix you can
// see exactly where to extend.
export default defineConfig({
  plugins: [
    cloudflare(),
    ...(SHARED_SECRET ? [baerlyDevAuth({ secret: SHARED_SECRET, prefix: ["/v1", "/api"] })] : []),
  ],
});
