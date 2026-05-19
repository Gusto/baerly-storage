/**
 * Schema-validator adapter for `Db.insert` / `Query.update` /
 * `Query.replace` boundary checks.
 *
 * Compatible with any library implementing StandardSchemaV1 — Zod
 * 3.24+, Valibot 0.36+, ArkType 2.0+, and others
 * (<https://standardschema.dev/>). The interface is pure-type:
 * no runtime import, no peer dep.
 *
 * @example
 * ```ts
 * import { z } from "zod";
 * import { defineConfig } from "create-baerly/config";
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

import { BaerlyError } from "@baerly/protocol";

/**
 * Subset of the StandardSchemaV1 contract Baerly consumes at the
 * server boundary. The full spec lives at
 * <https://standardschema.dev/>; we copy the `validate` shape locally
 * because that's the only field the boundary calls, and inlining
 * preserves the repo's "no new runtime deps" rule (the spec package
 * is just this interface).
 */
export interface SchemaValidator<TInput = unknown, TOutput = TInput> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
    ) =>
      | { value: TOutput; issues?: undefined }
      | { issues: ReadonlyArray<SchemaIssue> }
      | Promise<{ value: TOutput; issues?: undefined } | { issues: ReadonlyArray<SchemaIssue> }>;
    readonly types?: { input: TInput; output: TOutput };
  };
}

/**
 * One per-field validation failure. `path` is the validator-native
 * shape — entries are either a bare `PropertyKey` (string / number /
 * symbol) or a `{ key: PropertyKey }` segment, mirroring the live
 * StandardSchemaV1 spec. `validateOrThrow` normalises both forms to
 * `(string | number)[]` before raising the resulting
 * `BaerlyError{code:"SchemaError"}`.
 */
export interface SchemaIssue {
  readonly message: string;
  /**
   * Field path. Each entry is a string key, integer index, symbol
   * (rare), or a `{ key: PropertyKey }` segment object — Zod 3.24+,
   * Valibot 0.36+, ArkType 2.0+ etc. all emit the latter shape.
   */
  readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined;
}

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
