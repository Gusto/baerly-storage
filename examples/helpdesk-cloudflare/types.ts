import type { z } from "zod";
import config, { TicketSchema } from "./baerly.config.ts";

/**
 * Compile-time row type derived from the Zod schema in
 * `baerly.config.ts`. Single source of truth — adding a field to
 * the schema adds it here, and call sites pick it up via
 * `BaerlyClient<typeof config>`.
 */
export type Ticket = z.infer<typeof TicketSchema>;

/**
 * Enum tuples re-exported for the UI's `<select>` rendering.
 * Pulled directly off the Zod schema so the order stays in sync
 * with the validator.
 */
export const STATUSES = TicketSchema.shape.status.options;
export const PRIORITIES = TicketSchema.shape.priority.options;

// Keep a default `config` re-export so any future consumer can
// import the bound config via the same module that exports the
// row type.
export { config };
