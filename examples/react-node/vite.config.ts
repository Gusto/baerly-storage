import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { baerlyDev, loadDevVars } from "baerly-storage/dev/vite";
import config from "./baerly.config.ts";

const vars = loadDevVars(".env");
const SECRET = vars["SHARED_SECRET"] ?? process.env["SHARED_SECRET"] ?? "dev-shared-secret";

export default defineConfig({
  build: { outDir: "dist/client", emptyOutDir: true },
  server: { port: 5173 },
  plugins: [
    react(),
    baerlyDev({
      config,
      secret: SECRET,
      dataDir: resolve(import.meta.dirname, ".baerly-data"),
    }),
  ],
});
