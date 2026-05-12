import { defineConfig } from "create-baerly/config";

export default defineConfig({
  app: "{{appName}}",
  tenant: "{{tenant}}",
  target: "cloudflare",
  domain: undefined,
});
