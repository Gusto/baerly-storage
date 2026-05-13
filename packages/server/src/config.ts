/**
 * Phase-8 collection-config schema. The `baerly.config.ts` file that
 * ticket 38's `npm create baerly` scaffold ships at the app root has
 * this shape; adapters load it once per process and thread declared
 * fields (`indexes`, future: `schema`, `replica_identity`, lifecycle
 * hooks) into the per-collection `ServerWriter`.
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
 * import { defineConfig } from "@baerly/server";
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

/**
 * One collection's declarative config. Today only `indexes` is
 * consumed; future tickets add `schema`, `replica_identity`, and
 * lifecycle hooks.
 */
export interface CollectionDefinition {
  /**
   * Secondary indexes declared for this collection. Each declared
   * index produces one zero-byte PUT per commit (when the indexed
   * field is set on the doc) inside the same fence as the log
   * entry and content body. See `./indexes.ts` for the key shape.
   */
  readonly indexes?: ReadonlyArray<IndexDefinition>;
}

/**
 * The full `baerly.config.ts` shape. Re-exported from
 * `@baerly/server` and consumed by the day-1 scaffold (ticket 38)
 * + the `baerly admin rebuild-index` CLI.
 */
export interface BaerlyConfig {
  /** Per-collection declarations, keyed by collection name. */
  readonly collections?: Readonly<Record<string, CollectionDefinition>>;
}

/**
 * Identity helper that pins the config's TypeScript shape so IDEs
 * surface autocomplete and `tsgo --noEmit` catches typos at write
 * time. Returns its input verbatim — no runtime transformation.
 */
export const defineConfig = (cfg: BaerlyConfig): BaerlyConfig => cfg;
