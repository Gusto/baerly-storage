/**
 * Schema-validator runtime helper for `Db.insert` / `Query.update` /
 * `Table.replace` boundary checks.
 *
 * The `SchemaValidator` / `SchemaIssue` TYPES live in
 * `@baerly/protocol` (cross-platform). This module owns the runtime
 * helper `validateOrThrow` that runs a validator and raises a
 * `BaerlyError{code:"SchemaError"}` on failure.
 *
 * @example
 * ```ts
 * import { z } from "zod";
 * import { defineConfig } from "baerly-storage/config";
 *
 * const Ticket = z.object({
 *   _id: z.string(),
 *   status: z.enum(["open", "closed"]),
 *   title: z.string().min(1),
 * });
 *
 * export default defineConfig({
 *   collections: {
 *     tickets: { schema: Ticket },
 *   },
 * });
 * ```
 */

import { BaerlyError, type SchemaValidator } from "@baerly/protocol";

export type { SchemaIssue, SchemaValidator } from "@baerly/protocol";

/**
 * Run a validator and throw `BaerlyError{code:"SchemaError"}` on failure.
 * On success returns the validator's output (which for transforming
 * validators may differ from the input).
 *
 * Field paths are normalised to `(string | number)[]` so the wire shape
 * is JSON-clean. Symbol keys (rare; StandardSchemaV1 permits them) are
 * coerced to `String(sym)` — we never emit `symbol` on the wire.
 *
 * The thrown error's `message` carries a one-line summary
 * (`"<collection>.<verb>: <issuesCount> field(s) failed validation: <first>"`)
 * for stderr-readable logs; the structured `issues` are on `.issues`.
 */
export const validateOrThrow = async <TIn, TOut>(
  schema: SchemaValidator<TIn, TOut>,
  candidate: unknown,
  context: { readonly collection: string; readonly verb: "insert" | "update" | "replace" },
): Promise<TOut> => {
  const result = await schema["~standard"].validate(candidate);
  if (result.issues === undefined) {
    return result.value;
  }
  const issues = result.issues.map((i) => ({
    path: (i.path ?? []).map((p) => {
      // StandardSchemaV1 permits `{ key: PropertyKey }` segments
      // (Zod 3.24+, Valibot 0.36+) alongside bare PropertyKeys.
      const raw = typeof p === "object" && p !== null && "key" in p ? p.key : p;
      return typeof raw === "number" ? raw : String(raw);
    }),
    message: i.message,
  }));
  const first = issues[0];
  const summary =
    first === undefined
      ? "schema validation failed (no issues reported)"
      : `${first.path.length === 0 ? "<root>" : first.path.join(".")}: ${first.message}`;
  throw new BaerlyError(
    "SchemaError",
    `${context.collection}.${context.verb}: ${issues.length} field${issues.length === 1 ? "" : "s"} failed validation: ${summary}`,
    undefined,
    issues,
  );
};
