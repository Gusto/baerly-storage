import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { baerlyDev } from "baerly-storage/dev/vite";
import config from "./baerly.config.ts";
import { seedTickets } from "./src/server/seed.ts";

export default defineConfig({
  plugins: [
    react(),
    baerlyDev({
      config,
      secret: process.env["HELPDESK_SECRET"] ?? "dev-helpdesk-secret",
      dataDir: resolve(import.meta.dirname, ".baerly-data"),
      seed: seedTickets,
      hints: [
        { key: "data", value: ".baerly-data/" },
        { key: "reset", value: "pnpm reset" },
      ],
    }),
  ],
  server: { port: 5173 },
});
