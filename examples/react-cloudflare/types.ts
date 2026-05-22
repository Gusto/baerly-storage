import type { z } from "zod";
import config, { type NoteSchema } from "./baerly.config.ts";

/**
 * Compile-time row type derived from the Zod schema in
 * `baerly.config.ts`. Single source of truth — adding a field to
 * the schema adds it here, and call sites pick it up via
 * `BaerlyClient<typeof config>`.
 *
 * **Replacing the demo?** `src/web/{NoteForm,NoteList,NoteDetail}.tsx`
 * import `Note` from this file. Rename the Zod schema in
 * `baerly.config.ts` first — this file follows automatically via
 * `z.infer`, and the consumer imports update by find-replace.
 */
export type Note = z.infer<typeof NoteSchema>;

// Keep a default `config` re-export so any future consumer can
// import the bound config via the same module that exports the
// row type.
export { config };
