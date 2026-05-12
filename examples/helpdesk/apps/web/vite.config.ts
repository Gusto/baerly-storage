import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Proxy /v1/* to the server on :3000 so the browser sends
    // same-origin requests (no CORS dance).
    proxy: {
      "/v1": {
        target: process.env.HELPDESK_SERVER_URL ?? "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
});
