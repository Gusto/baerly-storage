import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { baerlyDevAuth, loadDevVars } from "baerly-storage/dev/vite";

// `.dev.vars` is consumed by the Worker side via @cloudflare/vite-plugin.
// We also load it here so the SPA dev-auth plugin can inject the same
// Bearer token the verifier expects — the secret never enters the SPA
// bundle (this plugin runs only in dev, server-side).
const vars = loadDevVars(".dev.vars");
const SECRET = vars["SHARED_SECRET"] ?? process.env["SHARED_SECRET"] ?? "";

export default defineConfig({
  plugins: [
    react(),
    cloudflare(),
    ...(SECRET !== "" ? [baerlyDevAuth({ secret: SECRET })] : []),
  ],
});
