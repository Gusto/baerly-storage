import { defineConfig } from "vite";
import { baerlyDevAuth, loadDevVars } from "baerly-storage/dev/vite";

// Same secret source as the Node server itself (`pnpm start` reads
// SHARED_SECRET from process.env / .env). Loading it here lets the
// Vite dev-auth plugin inject Authorization without requiring the
// user to shell-export the variable before `pnpm dev`.
const vars = loadDevVars(".env");
const SECRET = vars["SHARED_SECRET"] ?? process.env["SHARED_SECRET"] ?? "";

export default defineConfig({
  build: { outDir: "dist/client", emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { "/v1": "http://127.0.0.1:3000" },
  },
  plugins: SECRET !== "" ? [baerlyDevAuth({ secret: SECRET })] : [],
});
