/**
 * Shared per-tenant `Db` cache factory for the load-harness runners
 * (seed.ts, replay.ts). Both build one `Db` per (app, tenant) — same
 * lifecycle as production — memoised in a small Map (≤ N tenants per
 * preset; constructing a `Db` is cheap, no I/O). The empty-tenant
 * fallback and the optional-`config` spread are identical across both
 * runners, so the factory lives here and each runner calls it.
 */

import type { Storage } from "@baerly/protocol";
import { Db, type BaerlyConfig } from "@baerly/server";
import type { CountingStorage } from "../../storage.ts";

export interface DbFactoryOpts {
  readonly storage: CountingStorage;
  readonly app: string;
  /** Default tenant when a tenant id is empty (degenerate). */
  readonly defaultTenant: string;
  /**
   * Optional {@link BaerlyConfig} forwarded to `Db.create`. Both phases
   * MUST receive the same config so index entries materialise and reads
   * route through the matching index.
   */
  readonly config?: BaerlyConfig;
}

/**
 * Returns a memoising `dbFor(tenantId)` bound to `opts`. Distinct
 * tenant ids get distinct `Db` instances; the empty string maps onto
 * `opts.defaultTenant`.
 */
export function makeDbFactory(opts: DbFactoryOpts): (tenantId: string) => Db {
  const dbs = new Map<string, Db>();
  return (tenantId: string): Db => {
    let db = dbs.get(tenantId);
    if (db === undefined) {
      const tenant = tenantId.length === 0 ? opts.defaultTenant : tenantId;
      db = Db.create({
        storage: opts.storage as unknown as Storage,
        app: opts.app,
        tenant,
        ...(opts.config !== undefined && { config: opts.config }),
      });
      dbs.set(tenantId, db);
    }
    return db;
  };
}
