/* eslint-disable no-underscore-dangle -- `_id` is the locked primary-key
   field on document shapes (see `@baerly/protocol`'s `Collection<T>`
   declaration); the synthetic seed populates it directly. */

/**
 * Cross-profile correctness gate.
 *
 * THE INVARIANT (the thing this file PROVES): a `MaintenanceProfile`
 * changes only the RATE of maintenance (how many entries fold per pass,
 * how hard / how often GC runs) and the defer threshold — NEVER the
 * stored data, the query semantics, or any correctness property. So for
 * the SAME deterministic op sequence the materialized view a reader sees
 * is BYTE-FOR-BYTE IDENTICAL across every profile. Only the maintenance
 * RATE — how much of the tail each profile has folded into the snapshot —
 * differs.
 *
 * Two assertions, jointly non-vacuous:
 *
 *   (A) EQUIVALENCE — driving the same op stream through the REAL
 *       write-tick path (the writer's post-CAS `runBoundedMaintenance`
 *       dispatch, reached inside an ALS maintenance scope) under each
 *       profile leaves `find()`/`all()` returning the SAME rows (sorted
 *       by `_id`), equal to a no-maintenance reference read of the same
 *       stream. find() reads snapshot + live tail, so equivalence holds
 *       no matter how much each profile folded.
 *
 *   (B) RATE-DIFFERS — the profiles are genuinely distinct: given the
 *       same pre-built tail, ONE write-tick fold pass advances
 *       `log_seq_start` by exactly the profile's `maxFoldEntriesPerPass`
 *       (Node 200, CF-free 20), so Node folds strictly more per pass.
 *       Without (B), (A) could be passing on two accidentally identical
 *       configs — this is the coverage the reviewer flagged as missing.
 *
 * Memory + local-fs backends, zero infra, default vitest project.
 */

import { afterEach, describe, expect, test } from "vitest";
import {
  type Collection,
  CURRENT_JSON_SCHEMA_VERSION,
  createCurrentJson,
  type DocumentData,
  MAINTENANCE_PROFILE_CF_FREE,
  MAINTENANCE_PROFILE_NODE,
  MemoryStorage,
  readCurrentJson,
  type Storage,
} from "@baerly/protocol";
import { LocalFsStorage } from "@baerly/dev";
import { Db } from "@baerly/server";
import {
  type BoundedMaintenanceOptions,
  type MaintenanceProfile,
  runBoundedMaintenance,
} from "@baerly/server/maintenance";
import { createObservabilityContext, runWithContext } from "@baerly/server/observability";
import { Writer } from "@baerly/server/_internal/testing";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const APP = "app";
const TENANT = "tenant";
const COLLECTION = "tickets";
const TABLE_PREFIX = `app/${APP}/tenant/${TENANT}/manifests/${COLLECTION}`;
const CURRENT_JSON_KEY = `${TABLE_PREFIX}/current.json`;

interface Ticket extends DocumentData {
  _id: string;
  status: "open" | "closed";
  priority: number;
  rev: number;
}

const bootstrap = async (storage: Storage): Promise<void> => {
  await createCurrentJson(storage, CURRENT_JSON_KEY, {
    schema_version: CURRENT_JSON_SCHEMA_VERSION,
    snapshot: null,
    next_seq: 0,
    log_seq_start: 0,
    writer_fence: { epoch: 0, owner: "profile-equivalence", claimed_at: "" },
    tail_bytes: 0,
    snapshot_bytes: 0,
    snapshot_rows: 0,
  });
};

const sortById = <T extends { _id: string }>(rows: readonly T[]): T[] =>
  [...rows].toSorted((a, b) => {
    if (a._id < b._id) {
      return -1;
    }
    if (a._id > b._id) {
      return 1;
    }
    return 0;
  });

const WORKING_SET = 50; // bounded live doc set ⇒ constant live floor
const BODY_BYTES = 2000; // bodies big enough that the ratio gate trips and folds fire
const TOTAL_OPS = 1200; // long enough that both profiles fold many times

interface Op {
  readonly op: "I" | "U" | "D";
  readonly docId: string;
  readonly body?: Ticket;
}

/**
 * Deterministic, profile-independent op stream over a bounded id space:
 * a mix of inserts / updates / deletes that leaves a non-trivial
 * surviving snapshot AND keeps the tail churning (superseded content
 * blobs ⇒ orphans GC must reclaim). The same sequence is replayed into
 * every bucket, so any post-stream difference is attributable solely to
 * the profile.
 */
const buildOps = (): readonly Op[] => {
  const blob = "x".repeat(BODY_BYTES);
  const ops: Op[] = [];
  for (let i = 0; i < TOTAL_OPS; i++) {
    const docId = `d${i % WORKING_SET}`;
    // Every 13th op on the second lap deletes its doc, then a later op
    // re-inserts it — exercising the delete/re-insert path. The rest
    // alternate insert/update churn over the bounded working set.
    if (i >= WORKING_SET && i % 13 === 0) {
      ops.push({ op: "D", docId });
    } else {
      ops.push({
        op: i % 2 === 0 ? "I" : "U",
        docId,
        body: {
          _id: docId,
          status: i % 3 === 0 ? "closed" : "open",
          priority: i % 5,
          rev: Math.floor(i / WORKING_SET),
          blob,
        } as Ticket & { blob: string },
      });
    }
  }
  return ops;
};

/** Replay the op stream through the REAL {@link Writer}. The Writer
 *  ALWAYS ticks write-tick maintenance after a commit (CF-free-safe
 *  defaults when no context is set — a bare `Db.create()` maintains out
 *  of the box), so to control the profile we always wrap in an ALS
 *  maintenance scope:
 *   - `profile` given ⇒ ticks at that profile's rate (the production path);
 *   - `profile` omitted ⇒ `disabled: true`, a truly maintenance-FREE
 *     reference seed (pure log tail, no folding). */
const replay = async (
  storage: Storage,
  ops: readonly Op[],
  profile?: MaintenanceProfile,
): Promise<void> => {
  const writer = new Writer({ storage, currentJsonKey: CURRENT_JSON_KEY });
  const commitAll = async (): Promise<void> => {
    for (const o of ops) {
      if (o.op === "D") {
        await writer.commit({ op: "D", collection: COLLECTION, docId: o.docId });
      } else {
        await writer.commit({ op: o.op, collection: COLLECTION, docId: o.docId, body: o.body! });
      }
    }
  };
  const maintenance =
    profile === undefined
      ? { disabled: true }
      : {
          options: {
            profile,
            minEntriesToCompact: 50,
            phasesPerTick: "both", // fold AND gc per tick
            gcGraceMillis: 0, // sweep marked orphans the same pass (no 8-day clock advance)
          } satisfies BoundedMaintenanceOptions,
        };
  await runWithContext(createObservabilityContext({ maintenance }), commitAll);
};

const readRows = async (storage: Storage): Promise<Ticket[]> => {
  const db = Db.create({ storage, app: APP, tenant: TENANT });
  const tbl = db.collection(COLLECTION) as Collection<Ticket>;
  return sortById(await tbl.where({}).all());
};

interface ProfileCase {
  readonly label: string;
  readonly profile: MaintenanceProfile;
}

// Small table so adding a third profile later is a one-line addition.
const PROFILE_CASES: readonly ProfileCase[] = [
  { label: "cf-free", profile: MAINTENANCE_PROFILE_CF_FREE },
  { label: "node", profile: MAINTENANCE_PROFILE_NODE },
];

interface Variant {
  readonly label: "memory" | "local-fs";
  readonly build: () => Promise<{ storage: Storage; cleanup?: () => Promise<void> }>;
}

const VARIANTS: readonly Variant[] = [
  { label: "memory", build: async () => ({ storage: new MemoryStorage() }) },
  {
    label: "local-fs",
    build: async () => {
      const root = await mkdtemp(join(tmpdir(), "baerly-profile-equiv-"));
      return {
        storage: new LocalFsStorage({ root }),
        cleanup: async () => {
          await rm(root, { recursive: true, force: true }).catch(() => {});
        },
      };
    },
  },
];

describe("MaintenanceProfile cross-profile correctness", () => {
  for (const variant of VARIANTS) {
    describe(variant.label, () => {
      let cleanups: Array<() => Promise<void>> = [];
      afterEach(async () => {
        for (const c of cleanups) {
          await c();
        }
        cleanups = [];
      });

      const freshBucket = async (): Promise<Storage> => {
        const made = await variant.build();
        if (made.cleanup) {
          cleanups.push(made.cleanup);
        }
        await bootstrap(made.storage);
        return made.storage;
      };

      test(
        "(A) materialized state is byte-for-byte identical across every profile (and the no-maintenance reference)",
        { timeout: 60_000 },
        async () => {
          const ops = buildOps();

          // Reference: the same stream with NO maintenance at all. Every
          // profile's maintained view must equal this.
          const refStorage = await freshBucket();
          await replay(refStorage, ops);
          const reference = await readRows(refStorage);
          // Sanity: a non-trivial surviving set landed.
          expect(reference.length).toBeGreaterThan(0);
          expect(reference.length).toBeLessThanOrEqual(WORKING_SET);

          // Each profile replays the SAME stream through the real
          // write-tick path on its own fresh bucket.
          const maintained: Record<string, Ticket[]> = {};
          for (const pc of PROFILE_CASES) {
            const storage = await freshBucket();
            await replay(storage, ops, pc.profile);

            // Non-vacuity: a fold actually landed under this profile —
            // maintenance ran, this isn't comparing two un-maintained
            // buckets.
            const cur = await readCurrentJson(storage, CURRENT_JSON_KEY);
            expect(cur!.json.snapshot, `${pc.label}: a fold must have landed`).not.toBeNull();
            expect(cur!.json.log_seq_start, `${pc.label}: the tail folded`).toBeGreaterThan(0);

            maintained[pc.label] = await readRows(storage);
          }

          // EQUIVALENCE: every profile's view equals the no-maintenance
          // reference, byte-for-byte (deep-equal over sorted rows).
          for (const pc of PROFILE_CASES) {
            expect(
              maintained[pc.label],
              `${pc.label} view must equal the no-maintenance reference`,
            ).toEqual(reference);
          }
          // Explicit cross-profile pin so a future third profile is also
          // checked against the others, not only against the reference.
          const [first, ...rest] = PROFILE_CASES;
          for (const pc of rest) {
            expect(maintained[pc.label], `${pc.label} view must equal ${first!.label}'s`).toEqual(
              maintained[first!.label],
            );
          }
        },
      );

      test(
        "(B) profiles genuinely differ in maintenance RATE: ONE fold pass advances log_seq_start by exactly maxFoldEntriesPerPass",
        { timeout: 60_000 },
        async () => {
          // Pre-build a tail bigger than either profile's per-pass slice
          // with NO maintenance, so the fold start state is identical for
          // both arms. 300 fresh inserts > node's 200/pass slice ⇒ neither
          // profile drains the whole tail in one pass, so the per-pass
          // advance is exactly maxFoldEntriesPerPass for each.
          const TAIL = 300;
          const tailOps: Op[] = Array.from({ length: TAIL }, (_, i) => {
            const docId = `n${i.toString().padStart(4, "0")}`;
            return {
              op: "I" as const,
              docId,
              body: {
                _id: docId,
                status: "open",
                priority: i % 5,
                rev: 0,
                blob: "x".repeat(BODY_BYTES),
              } as Ticket & { blob: string },
            };
          });

          // The profiles must actually be distinct in fold rate — else (A)
          // would be testing two accidentally-equal configs.
          expect(
            MAINTENANCE_PROFILE_NODE.maxFoldEntriesPerPass,
            "node folds a larger slice per pass than cf-free",
          ).toBeGreaterThan(MAINTENANCE_PROFILE_CF_FREE.maxFoldEntriesPerPass);

          // Run EXACTLY ONE write-tick fold pass under `profile` over the
          // pre-built tail; return how far log_seq_start advanced. `prevSeq`
          // is set to next_seq so NO GC cadence boundary is crossed —
          // isolating the fold so the advance is purely the fold slice.
          const oneFoldAdvance = async (profile: MaintenanceProfile): Promise<number> => {
            const storage = await freshBucket();
            await replay(storage, tailOps); // no maintenance during seed
            const cur = (await readCurrentJson(storage, CURRENT_JSON_KEY))!.json;
            const before = cur.log_seq_start;
            await runBoundedMaintenance(
              { storage, currentJsonKey: CURRENT_JSON_KEY, prevSeq: cur.next_seq },
              { profile, minEntriesToCompact: 50, phasesPerTick: "single" },
            );
            const after = (await readCurrentJson(storage, CURRENT_JSON_KEY))!.json.log_seq_start;
            return after - before;
          };

          const cfAdvance = await oneFoldAdvance(MAINTENANCE_PROFILE_CF_FREE);
          const nodeAdvance = await oneFoldAdvance(MAINTENANCE_PROFILE_NODE);

          // A single fold pass advances by exactly the profile's slice
          // size — the definitional rate difference.
          expect(cfAdvance, "cf-free folds exactly its slice in one pass").toBe(
            MAINTENANCE_PROFILE_CF_FREE.maxFoldEntriesPerPass,
          );
          expect(nodeAdvance, "node folds exactly its slice in one pass").toBe(
            MAINTENANCE_PROFILE_NODE.maxFoldEntriesPerPass,
          );
          // And node's pass is strictly larger — the profiles are genuinely
          // distinct, not accidentally equal.
          expect(
            nodeAdvance,
            `node folds ${nodeAdvance}/pass, cf-free folds ${cfAdvance}/pass`,
          ).toBeGreaterThan(cfAdvance);
        },
      );
    });
  }
});
