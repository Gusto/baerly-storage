import { defineConfig } from "baerly-storage/config";

/**
 * One collection (`notes`) ships out of the box so the wired
 * example in `src/web/main.ts` round-trips through the DB on
 * first load. No schema is declared — `defineConfig` accepts
 * collection entries with neither `schema` nor `indexes` set, and
 * the writer treats them as schema-free. See `helpdesk-cloudflare`
 * for the schema-bound shape.
 */
export default defineConfig({
  app: "minimal-cloudflare",
  tenant: "minimal-demo",
  target: "cloudflare",
  domain: undefined,
  collections: {
    notes: {},
  },
});
