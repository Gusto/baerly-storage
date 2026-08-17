/* eslint-disable no-underscore-dangle -- `_id` is the locked primary key. */

/**
 * @internal — the shared document model behind this package's property-based
 * suites (`compactor-randomized`, `log-retention-randomized`,
 * `maintenance-safety-randomized`).
 *
 * All three drive the same four-document `I`/`U`/`D` workload through a real
 * `Writer` and compare the reconstructed reader view against an in-memory
 * model, so the arbitrary and the model-apply loop live here: widening the op
 * kinds or the id alphabet must not have to be mirrored across every suite,
 * or one of them silently keeps exploring the narrower space.
 *
 * `reconstructView` walks the durable `[log_seq_start, tail_hint)` range only.
 * `compactor-randomized.test.ts` keeps its own variant that additionally
 * forward-probes past `tail_hint`, because that suite's idempotence assertion
 * depends on seeing entries a fold has not yet stamped a hint for.
 *
 * Test-only: no bundler entry reaches this module and it is deliberately not
 * re-exported through `_internal/testing.ts`.
 */

import { fc } from "@fast-check/vitest";
import {
  CURRENT_JSON_SCHEMA_VERSION,
  createCurrentJson,
  type DocumentData,
  logSeqStartOf,
  readCurrentJson,
  type Storage,
} from "@baerly/protocol";
import { foldLogEntriesOnto, walkLogRange } from "../log-walk.ts";
import { loadSnapshotAsMap } from "../snapshot.ts";
import type { Writer } from "../writer.ts";

/** Generous ceiling: a property run is many rounds of real commits. */
export const PROP_TIMEOUT_MS = 600_000;

export const CURRENT_JSON_KEY = "app/x/tenant/t/manifests/tickets/current.json";
export const LOG_PREFIX = "app/x/tenant/t/manifests/tickets";
export const COLLECTION = "tickets";

export type Doc = DocumentData & { _id: string; v: number };

/**
 * Four ids over a 100-value payload space: small enough that a 20-op round
 * reliably produces overwrites and re-inserts (the interesting fold and
 * retirement inputs) rather than 20 unrelated documents.
 */
export const opArb = fc.oneof(
  fc.record({
    kind: fc.constant("I" as const),
    id: fc.constantFrom("a", "b", "c", "d"),
    v: fc.integer({ min: 0, max: 99 }),
  }),
  fc.record({
    kind: fc.constant("U" as const),
    id: fc.constantFrom("a", "b", "c", "d"),
    v: fc.integer({ min: 0, max: 99 }),
  }),
  fc.record({ kind: fc.constant("D" as const), id: fc.constantFrom("a", "b", "c", "d") }),
);

export type Op = { kind: "I" | "U" | "D"; id: string; v?: number };

/** A freshly provisioned, never-folded collection. */
export const seedCurrentJson = async (storage: Storage): Promise<void> => {
  await createCurrentJson(storage, CURRENT_JSON_KEY, {
    schema_version: CURRENT_JSON_SCHEMA_VERSION,
    snapshot: null,
    tail_hint: 0,
    log_seq_start: 0,
    writer_fence: { epoch: 0, owner: "test", claimed_at: "" },
    snapshot_bytes: 0,
    snapshot_rows: 0,
  });
};

/**
 * Reconstruct the reader's materialized view the way `runRead` does: snapshot
 * base + the folded durable log range.
 */
export const reconstructView = async (storage: Storage): Promise<Record<string, DocumentData>> => {
  const read = await readCurrentJson(storage, CURRENT_JSON_KEY);
  if (read === null) {
    throw new Error("current.json missing");
  }
  const base =
    read.json.snapshot === null
      ? new Map<string, DocumentData>()
      : await loadSnapshotAsMap(storage, read.json.snapshot, COLLECTION);
  const tail = await walkLogRange(
    storage,
    LOG_PREFIX,
    logSeqStartOf(read.json),
    read.json.tail_hint,
  );
  foldLogEntriesOnto(base, tail, { collection: COLLECTION });
  return Object.fromEntries(base);
};

/**
 * Apply a generated op batch through a real `Writer`, keeping `model` as the
 * oracle. Ops the model says cannot apply (insert over a live id, update or
 * delete of an absent id) are skipped rather than expected to fail, so the
 * generated space stays entirely valid commits.
 */
export const applyOps = async (
  writer: Writer,
  model: Map<string, Doc>,
  ops: ReadonlyArray<Op>,
): Promise<void> => {
  for (const op of ops) {
    if (op.kind === "I") {
      if (model.has(op.id)) {
        continue;
      }
      const doc: Doc = { _id: op.id, v: op.v! };
      await writer.commit({ op: "I", collection: COLLECTION, docId: op.id, body: doc });
      model.set(op.id, doc);
    } else if (op.kind === "U") {
      if (!model.has(op.id)) {
        continue;
      }
      const doc: Doc = { _id: op.id, v: op.v! };
      await writer.commit({ op: "U", collection: COLLECTION, docId: op.id, body: doc });
      model.set(op.id, doc);
    } else {
      if (!model.has(op.id)) {
        continue;
      }
      await writer.commit({ op: "D", collection: COLLECTION, docId: op.id });
      model.delete(op.id);
    }
  }
};
