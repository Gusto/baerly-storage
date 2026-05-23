import type { z } from "zod";
import type { NoteSchema } from "./baerly.config.ts";

/**
 * Compile-time row type derived from the Zod schema in
 * `baerly.config.ts`. Single source of truth — adding a field to
 * the schema adds it here, and call sites pick it up via
 * `BaerlyClient<typeof config>`.
 */
export type Note = z.infer<typeof NoteSchema>;
