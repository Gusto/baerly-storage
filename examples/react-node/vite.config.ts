import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { baerlyDev } from "baerly-storage/dev/vite";
import config from "./baerly.config.ts";

export default defineConfig({
  build: { outDir: "dist/client", emptyOutDir: true },
  server: { port: 5173 },
  plugins: [
    react(),
    baerlyDev({
      config,
      dataDir: resolve(import.meta.dirname, ".baerly-data"),
    }),
  ],
});
