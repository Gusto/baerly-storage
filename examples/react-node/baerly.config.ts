import { z } from "zod";
import { defineConfig } from "baerly-storage/config";

/**
 * Zod schema for one note. Source of truth for both the runtime
 * `SchemaValidator` consumed by `baerly-storage`'s writer and the
 * compile-time `Note` row type imported by the UI.
 */
export const NoteSchema = z.object({
  _id: z.string(),
  body: z.string().min(1),
  created_at: z.string(),
});

export default defineConfig({
  app: "react-node",
  tenant: "react-demo",
  target: "node",
  domain: undefined,
  collections: {
    notes: { schema: NoteSchema },
  },
});
