import { defineConfig } from "baerly-storage/config";

export default defineConfig({
  app: "minimal-cloudflare",
  tenant: "minimal-demo",
  target: "cloudflare",
  domain: undefined,
  collections: {},
});
