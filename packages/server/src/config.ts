/**
 * Collection-config schema. The `baerly.config.ts` file that the
 * `npm create baerly` scaffold ships at the app root has this shape;
 * adapters load it once per process and thread declared fields
 * (`indexes`, future: `schema`, `replica_identity`, lifecycle hooks)
 * into the per-collection `ServerWriter`.
 *
 * The {@link defineConfig} helper returns its input verbatim, but
 * its return type pins the shape so IDEs surface autocomplete on
 * `collections.<name>.indexes[].on`.
 *
 * @see ./indexes.ts — `IndexDefinition` (re-exported here) +
 *      validation + key encoding.
 *
 * @example
 * ```ts
 * import { defineConfig } from "baerly-storage/config";
 *
 * export default defineConfig({
 *   collections: {
 *     tickets: {
 *       indexes: [
 *         { name: "by_status", on: "status" },
 *         { name: "by_assignee", on: "assignee" },
 *       ],
 *     },
 *   },
 * });
 * ```
 */

import type { IndexDefinition } from "./indexes.ts";
import type { SchemaValidator } from "./schema.ts";

/**
 * One collection's declarative config. Today `indexes` and `schema`
 * are consumed; future tickets add `replica_identity` and lifecycle
 * hooks.
 */
export interface CollectionDefinition {
  /**
   * Secondary indexes declared for this collection. Each declared
   * index produces one zero-byte PUT per commit (when the indexed
   * field is set on the doc) inside the same fence as the log
   * entry and content body. See `./indexes.ts` for the key shape.
   */
  readonly indexes?: ReadonlyArray<IndexDefinition>;
  /**
   * Optional schema for this collection. When set, every server-side
   * `insert` / `update` / `replace` validates the resulting post-image
   * before committing — invalid input throws
   * `BaerlyError{code:"SchemaError"}` carrying a `.issues` array of
   * `{ path, message }` entries.
   *
   * Adapter: StandardSchemaV1 (see `./schema.ts`). Compatible with
   * Zod 3.24+, Valibot 0.36+, ArkType 2.0+ today; any future library
   * implementing the spec works without a code change here.
   *
   * `undefined` means no validation — every write proceeds as today
   * (zero overhead, today's tests untouched).
   */
  readonly schema?: SchemaValidator;
}

/**
 * The full `baerly.config.ts` shape. Re-exported from
 * `baerly-storage` and consumed by the day-1 `npm create baerly`
 * scaffold + the `baerly admin rebuild-index` CLI.
 */
export interface BaerlyConfig {
  /** Per-collection declarations, keyed by collection name. */
  readonly collections?: Readonly<Record<string, CollectionDefinition>>;
}

/**
 * Identity helper that pins the config's TypeScript shape so IDEs
 * surface autocomplete and `tsgo --noEmit` catches typos at write
 * time. Returns its input verbatim — no runtime transformation.
 *
 * The `<const C extends BaerlyConfig>` signature preserves the exact
 * literal shape of `cfg` (collection names, schema types) in the
 * inferred return type. Downstream helpers `CollectionNames<C>` and
 * `RowOf<C, N>` use this narrow inference to drive end-to-end
 * type-safe table access.
 */
export const defineConfig = <const C extends BaerlyConfig>(cfg: C): C => cfg;

/**
 * Sentinel `BaerlyConfig` used as the default `TConfig` parameter
 * by consumers (`Db<TConfig>`, `BaerlyClient<TConfig>`). Setting
 * `collections` to `Record<never, never>` makes
 * `CollectionNames<UnboundConfig>` resolve to `never`, which in
 * turn makes the narrowing `.table<N extends CollectionNames<C>>(name: N)`
 * overload unsatisfiable; the legacy per-call generic
 * `.table<T>(name: string)` overload wins for consumers that
 * haven't opted in to typed configs.
 */
export type UnboundConfig = { readonly collections: Record<never, never> };

/**
 * Set of declared collection names on a `BaerlyConfig`, as a string
 * union. Resolves to `never` when no `collections` are declared
 * (notably for `UnboundConfig`), which the typed `Db` / client
 * overloads use to disable narrowing for unbound consumers.
 *
 * @example
 * ```ts
 * const config = defineConfig({
 *   collections: {
 *     tickets: { schema: TicketSchema },
 *     audits: {},
 *   },
 * });
 * type Names = CollectionNames<typeof config>; // "tickets" | "audits"
 * ```
 */
export type CollectionNames<C extends BaerlyConfig> = C extends {
  readonly collections: infer Cs;
}
  ? Extract<keyof Cs, string>
  : never;

/**
 * Row type for collection `N` on config `C`. Resolves to the
 * `StandardSchemaV1` output type of `C["collections"][N]["schema"]`
 * when one is declared; otherwise falls back to
 * `Record<string, unknown>`.
 *
 * The fallback is intentionally wider than the protocol's
 * `DocumentData`. Downstream call sites that need
 * `DocumentData` (e.g. `Table<T extends DocumentData>`)
 * apply the intersection at their own seam — keeping that
 * constraint local to the consumer keeps THIS file independent of
 * `@baerly/protocol/src/json.ts`.
 *
 * @example
 * ```ts
 * const config = defineConfig({
 *   collections: {
 *     tickets: { schema: TicketSchema },
 *     audits: {},
 *   },
 * });
 * type Ticket = RowOf<typeof config, "tickets">; // z.infer<typeof TicketSchema>
 * type Audit = RowOf<typeof config, "audits">;   // Record<string, unknown>
 * ```
 */
export type RowOf<C extends BaerlyConfig, N extends CollectionNames<C>> = C extends {
  readonly collections: infer Cs;
}
  ? N extends keyof Cs
    ? Cs[N] extends { readonly schema: infer S }
      ? S extends SchemaValidator<unknown, infer Out>
        ? Out
        : Record<string, unknown>
      : Record<string, unknown>
    : Record<string, unknown>
  : Record<string, unknown>;
