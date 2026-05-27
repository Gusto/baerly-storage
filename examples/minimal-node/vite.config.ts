import { resolve } from "node:path";
import { defineConfig } from "vite";
import { baerlyDev } from "@gusto/baerly-storage/dev/vite";
import config from "./baerly.config.ts";

export default defineConfig({
  build: { outDir: "dist/client", emptyOutDir: true },
  server: { port: 5173 },
  plugins: [
    baerlyDev({
      config,
      dataDir: resolve(import.meta.dirname, ".baerly-data"),
    }),
  ],
});
