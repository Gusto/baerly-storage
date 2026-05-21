import { defineConfig } from "baerly-storage/config";

export default defineConfig({
  app: "helpdesk",
  tenant: "helpdesk-demo",
  target: "node",
  domain: undefined,
  collections: { tickets: {} },
});
