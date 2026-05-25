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
  // that includes `_id`, which the UI reads via `n._id`. UUIDv7 sorts
  // by server mint time, so the list orders newest-first via `_id` —
  // no separate `created_at` column needed.
  _id: z.string(),
  body: z.string().min(1),
});

/**
 * Compile-time row type derived from {@link NoteSchema}. Single
 * source of truth — adding a field to the schema adds it here.
 *
 * **Replacing the demo?** `src/web/{App,NoteList}.tsx` import
 * `Note` from this file; rename `NoteSchema` first and the
 * inferred type follows.
 */
export type Note = z.infer<typeof NoteSchema>;

export default defineConfig({
  app: "react-cloudflare",
  tenant: "react-demo",
  target: "cloudflare",
  auth: "none",
  collections: {
    notes: { schema: NoteSchema },
  },
});
