import { z } from "zod";
import { defineConfig } from "baerly-storage/config";

/**
 * Zod schema for one note. Source of truth for both the runtime
 * `SchemaValidator` consumed by `baerly-storage`'s writer and the
 * compile-time `Note` row type imported by the UI.
 */
export const NoteSchema = z.object({
  // Auto-stamped by the kernel on insert (UUIDv7) — never provide it from the
  // client. Declared here so `z.infer<typeof NoteSchema>` produces a row type
  // that includes `_id`, which the UI reads via `n._id`.
  _id: z.string(),
  body: z.string().min(1),
  created_at: z.string(),
});

export default defineConfig({
  app: "react-cloudflare",
  tenant: "react-demo",
  target: "cloudflare",
  domain: undefined,
  collections: {
    notes: { schema: NoteSchema },
  },
});
