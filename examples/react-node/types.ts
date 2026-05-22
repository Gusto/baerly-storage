import type { z } from "zod";
import type { NoteSchema } from "./baerly.config.ts";
import config from "./baerly.config.ts";

/**
 * Compile-time row type derived from the Zod schema in
 * `baerly.config.ts`. Single source of truth — adding a field to
 * the schema adds it here, and call sites pick it up via
 * `BaerlyClient<typeof config>`.
 */
export type Note = z.infer<typeof NoteSchema>;

// Keep a default `config` re-export so any future consumer can
// import the bound config via the same module that exports the
// row type.
export { config };
