import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Proxy /v1/* to wrangler dev (the Worker) on :8787. In production
    // the Worker serves both /v1/* and the static bundle on the same
    // origin via Workers Assets, so the client uses baseUrl="".
    proxy: {
      "/v1": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
      },
    },
  },
});
