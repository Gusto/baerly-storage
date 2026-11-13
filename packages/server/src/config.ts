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
import { validateIndexDefinition } from "./indexes.ts";

/**
 * Flatten `BaerlyConfig.collections` into the per-collection
 * `schemas` and `indexes` maps that {@link Db.create} consumes at
 * runtime. Used by the Cloudflare and Node adapters to pipe a
 * single `config` object through to the writer.
 *
 * Both adapters import this helper rather than inlining the loop
 * so the projection rule (drop empty index arrays; omit absent
 * schemas) stays in one place. Future `CollectionDefinition`
 * fields (lifecycle hooks, replica_identity) land here too.
 *
 * Every declared index is validated here, so a malformed declaration
 * fails at {@link Db.create} rather than at the first write. Indexes
 * change no read result, so validation is all a declaration buys:
 * it keeps the names and shapes reserved.
 *
 * @throws BaerlyError code="InvalidConfig" — an index `name` uses the
 *   reserved leading `_`, or an `on` field is a dotted path.
 * @throws BaerlyError code="SchemaError" — an index `name` fails
 *   `/^[a-z][a-z0-9_]*$/`, `on` is empty, or `predicate` is invalid.
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
      for (const index of def.indexes) {
        validateIndexDefinition(index);
      }
      indexes.set(name, def.indexes);
    }
  }
  return { schemas, indexes };
};
