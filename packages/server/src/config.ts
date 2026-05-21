/**
 * Runtime helpers for the `BaerlyConfig` shape.
 *
 * The type declarations (`BaerlyConfig`, `BaerlyAppConfig`,
 * `CollectionDefinition`, `CollectionNames`, `RowOf`, `UnboundConfig`,
 * `defineConfig`) live in `@baerly/protocol` — the cross-platform
 * package — so cross-platform consumers (client, scaffold
 * `baerly.config.ts`) can reference them without dragging the
 * Node-only server modules (`AsyncLocalStorage` etc.) into their
 * typecheck graph.
 *
 * This file keeps only the runtime helper `collectionsToMaps`, which
 * the Cloudflare and Node adapters call to flatten
 * `BaerlyConfig.collections` into the per-collection maps that
 * `Db.create` consumes.
 *
 * @see @baerly/protocol app-config.ts — type declarations.
 */

import type { BaerlyConfig, IndexDefinition, SchemaValidator } from "@baerly/protocol";

/**
 * Flatten `BaerlyConfig.collections` into the per-collection
 * `schemas` and `indexes` maps that {@link Db.create} consumes at
 * runtime. Used by the Cloudflare and Node adapters to pipe a
 * single `config` object through to the writer/planner.
 *
 * Both adapters import this helper rather than inlining the loop
 * so the projection rule (drop empty index arrays; omit absent
 * schemas) stays in one place. Future `CollectionDefinition`
 * fields (lifecycle hooks, replica_identity) land here too.
 */
export const collectionsToMaps = (
  collections: BaerlyConfig["collections"] | undefined,
): {
  schemas: ReadonlyMap<string, SchemaValidator>;
  indexes: ReadonlyMap<string, ReadonlyArray<IndexDefinition>>;
} => {
  const schemas = new Map<string, SchemaValidator>();
  const indexes = new Map<string, ReadonlyArray<IndexDefinition>>();
  if (collections === undefined) {
    return { schemas, indexes };
  }
  for (const [name, def] of Object.entries(collections)) {
    if (def.schema !== undefined) {
      schemas.set(name, def.schema);
    }
    if (def.indexes !== undefined && def.indexes.length > 0) {
      indexes.set(name, def.indexes);
    }
  }
  return { schemas, indexes };
};
