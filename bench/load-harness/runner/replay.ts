/**
 * Replay phase. Dispatches op-stream entries (ticket 51) through
 * `Db.table(collection)` calls, capturing per-op latency and a phase-
 * scoped `StorageSnapshot` from the `CountingStorage` wrapper.
 *
 * Caller is responsible for invoking phases in a valid order; the
 * runner only captures per-phase metrics.
 */

import type { Storage } from "@baerly/protocol";
import { Db } from "@baerly/server";
import type { StorageSnapshot } from "../../types.ts";
import type { CountingStorage } from "../../storage.ts";
import type { Op } from "../generators/ops.ts";

export type ReplayPhase = "ingest" | "query-pre" | "query-post" | "mixed";

export interface ReplayOpts {
  readonly storage: CountingStorage;
  readonly app: string;
  readonly defaultTenant: string;
  /** Collection name ops target. */
  readonly collection: string;
  readonly ops: readonly Op[];
  readonly phase: ReplayPhase;
  /** Per-logical-op latency capture (one entry per op). */
  readonly recordLatency: (kind: string, ms: number) => void;
}

export interface ReplayResult {
  readonly processed: number;
  readonly perKindCounts: Record<string, number>;
  readonly wallclockMs: number;
  readonly metrics: StorageSnapshot;
}

export async function runReplay(opts: ReplayOpts): Promise<ReplayResult> {
  opts.storage.reset();
  const t0 = performance.now();
  let processed = 0;
  const perKindCounts: Record<string, number> = {};

  const dbs = new Map<string, Db>();
  const dbFor = (tenantId: string): Db => {
    let db = dbs.get(tenantId);
    if (db === undefined) {
      const tenant = tenantId.length === 0 ? opts.defaultTenant : tenantId;
      db = Db.create({ storage: opts.storage as unknown as Storage, app: opts.app, tenant });
      dbs.set(tenantId, db);
    }
    return db;
  };

  for (const op of opts.ops) {
    const db = dbFor(op.tenantId);
    const opT0 = performance.now();
    await dispatch(db, opts.collection, op);
    opts.recordLatency(op.kind, performance.now() - opT0);
    processed++;
    perKindCounts[op.kind] = (perKindCounts[op.kind] ?? 0) + 1;
  }

  return {
    processed,
    perKindCounts,
    wallclockMs: performance.now() - t0,
    metrics: opts.storage.snapshot(),
  };
}

/**
 * Op dispatch. Exhaustive over `OpKind` — adding a new kind in ticket
 * 55 (or later) is a compiler error here, not a runtime no-op.
 *
 * `update`, `archive`: use the `recordId` from the op as a predicate
 * on `_id` so only the targeted row is affected.
 *
 * `list-recent`, `filtered-list`: no record target; list by recency
 * or a fixed predicate. The bench measures "S3 ops per list" so the
 * limit is intentionally generous (50) rather than unbounded.
 */
async function dispatch(db: Db, collection: string, op: Op): Promise<void> {
  switch (op.kind) {
    case "list-recent": {
      await db.table(collection).order({ createdAtMs: "desc" }).limit(50).all();
      return;
    }
    case "point-read": {
      if (op.recordId !== undefined) {
        await db.table(collection).where({ _id: op.recordId }).first();
      }
      return;
    }
    case "insert": {
      const body = {
        createdAtMs: Date.now(),
        popularityRank: 0,
        ...(op.recordId !== undefined && { _id: op.recordId }),
      };
      await db.table(collection).insert(body);
      return;
    }
    case "update": {
      if (op.recordId !== undefined) {
        // Patch the popularity rank to simulate an update touch.
        await db.table(collection).where({ _id: op.recordId }).update({ popularityRank: -1 });
      }
      return;
    }
    case "filtered-list": {
      // Filtered list on popularity rank = 0 (the "hot" records).
      await db.table(collection).where({ popularityRank: 0 }).limit(50).all();
      return;
    }
    case "archive": {
      if (op.recordId !== undefined) {
        // Archive = set status="archived" via predicate update.
        await db.table(collection).where({ _id: op.recordId }).update({ status: "archived" });
      }
      return;
    }
  }
  const kind: never = op.kind;
  throw new Error(`replay: unhandled op kind ${String(kind)}`);
}
