/**
 * Schema-validator adapter type for `Db.insert` / `Query.update` /
 * `Table.replace` boundary checks.
 *
 * Compatible with any library implementing StandardSchemaV1 — Zod
 * 3.24+, Valibot 0.36+, ArkType 2.0+, and others
 * (<https://standardschema.dev/>). The interface is pure-type:
 * no runtime import, no peer dep.
 *
 * The runtime helper that consumes this shape
 * (`validateOrThrow`) lives in `@baerly/server` —
 * the type lives in protocol so cross-platform consumers (client,
 * scaffold `baerly.config.ts`) can reference it without dragging
 * Node-only server modules into their import graph.
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
