/* eslint-disable no-underscore-dangle -- `_id` is the locked
   primary-key field on document shapes (see `@baerly/protocol`'s
   `Collection<T>`); this fuzz test threads it through the writer. */

/**
 * Crash-injection property test for the secondary-index emission
 * path.
 *
 * Wraps a `MemoryStorage` in `abortingStorage(inner)` (the same
 * shape `phase5-crash-fuzz.test.ts` uses), runs a fixed-shape commit
 * sequence with the K-th storage op aborted, then swaps to a clean
 * storage handle and calls `rebuildIndex` on the affected
 * `(table, index)` pair. The assertion:
 *
 *   the set of live index keys after `rebuildIndex` ==
 *     `allIndexKeysFor(live doc set)`
 *
 * where the live doc set is what the reader observes through the
 * unaborted storage view. This is the load-bearing rebuild-
 * idempotence claim: a crashed mid-commit either CAS-failed (no
 * effect on the live view) or CAS-succeeded (live view advanced;
 * orphan keys cleaned up by the rebuild). Either way the
 * post-rebuild index reflects the live view.
 *
 * Property arms:
 *
 *   - `abortAfter` ranges over 1..N where N covers every distinct
 *     storage op the writer would issue during a single commit.
 *     Bounded by `maxAbortPoints` so the property is fast under
 *     default `FC_NUM_RUNS=100`.
 *
 * Runtime: <1s at default; ~10s at `FC_NUM_RUNS=10000` under
 * `pnpm test:randomize`.
 */

import { fc, test } from "@fast-check/vitest";
import { describe, expect } from "vitest";

/**
 * Per-property timeout, in ms. At `FC_NUM_RUNS=100` (default
 * `pnpm test`) the property runs in well under a second; at
 * `FC_NUM_RUNS=10000` (`pnpm test:randomize`) it lands in a
 * few seconds even on a busy CI box. The default vitest timeout
 * (5000ms) is far too tight when other heavy property tests are
 * co-resident; mirror `phase5-crash-fuzz`'s pattern with a
 * comfortable upper bound.
 */
const PROP_TIMEOUT_MS = 600_000;
import {
  CURRENT_JSON_SCHEMA_VERSION,
  createCurrentJson,
  type DocumentData,
  MemoryStorage,
  type Storage,
} from "@baerly/protocol";
import { abortingStorage } from "../../../tests/fixtures/aborting-storage.ts";
import { allIndexKeysFor, type IndexDefinition } from "./indexes.ts";
import { probeTailFrom } from "./log-tail.ts";
import { rebuildIndex } from "./rebuild-index.ts";
import { Writer } from "./writer.ts";

const CURRENT_JSON_KEY = "app/x/tenant/t/manifests/tickets/current.json";
const LOG_PREFIX = "app/x/tenant/t/manifests/tickets";
const COLLECTION = "tickets";

const INDEXES: ReadonlyArray<IndexDefinition> = [
  { name: "by_status", on: "status" },
  { name: "by_assignee", on: "assignee" },
];

const listIndexKeysFor = async (storage: Storage, name: string): Promise<string[]> => {
  const out: string[] = [];
  for await (const entry of storage.list(`${LOG_PREFIX}/index/${name}/`)) {
    out.push(entry.key);
  }
  return out.toSorted();
};

// Doc shape carries the writer-required `_id` + the two indexed
// fields. The intersection with `DocumentData` widens it to
// satisfy the writer's body type without dropping the narrow
// member types we rely on for assertions.
type Doc = DocumentData & {
  readonly _id: string;
  readonly status: string;
  readonly assignee: string;
};

const provision = async (storage: Storage): Promise<void> => {
  await createCurrentJson(storage, CURRENT_JSON_KEY, {
    schema_version: CURRENT_JSON_SCHEMA_VERSION,
    snapshot: null,
    tail_hint: 0,
    log_seq_start: 0,
    writer_fence: { epoch: 0, owner: "crash-fuzz", claimed_at: "" },
    tail_bytes: 0,
    snapshot_bytes: 0,
    snapshot_rows: 0,
  });
};

describe("index emission survives a single crash anywhere in the commit", () => {
  test.prop({
    // Two seed inserts so the log is non-empty when the crash fires;
    // the third commit is the one we crash-inject inside.
    abortAfter: fc.integer({ min: 1, max: 20 }),
    seedCount: fc.integer({ min: 0, max: 3 }),
    finalOp: fc.constantFrom("I" as const, "U" as const, "D" as const),
  })(
    "rebuildIndex reconciles the index to the live doc set",
    async ({ abortAfter, seedCount, finalOp }) => {
      const inner = new MemoryStorage();
      await provision(inner);
      const goodWriter = new Writer({
        storage: inner,
        currentJsonKey: CURRENT_JSON_KEY,
        options: { indexes: INDEXES },
      });
      // Seed deterministically so the log is non-empty when the
      // crash-arming write fires.
      for (let i = 0; i < seedCount; i++) {
        const doc: Doc = {
          _id: `seed-${i}`,
          status: i % 2 === 0 ? "open" : "closed",
          assignee: i % 3 === 0 ? "alice" : "bob",
        };
        await goodWriter.commit({
          op: "I",
          collection: COLLECTION,
          docId: doc._id,
          body: doc,
        });
      }
      // For U / D the doc must exist; insert it cleanly first so the
      // crash-arming write has a pre-image to read.
      const targetId = "target";
      if (finalOp !== "I") {
        await goodWriter.commit({
          op: "I",
          collection: COLLECTION,
          docId: targetId,
          body: { _id: targetId, status: "open", assignee: "alice" },
        });
      }

      // Arm and try the crash-injected commit. Catch the synthetic
      // AbortError so the property body can continue to the rebuild.
      const handle = abortingStorage(inner);
      handle.armAt(abortAfter);
      const crashWriter = new Writer({
        storage: handle.storage,
        currentJsonKey: CURRENT_JSON_KEY,
        options: { indexes: INDEXES },
      });
      try {
        if (finalOp === "I") {
          await crashWriter.commit({
            op: "I",
            collection: COLLECTION,
            docId: targetId,
            body: { _id: targetId, status: "closed", assignee: "bob" },
          });
        } else if (finalOp === "U") {
          await crashWriter.commit({
            op: "U",
            collection: COLLECTION,
            docId: targetId,
            body: { _id: targetId, status: "wip", assignee: "bob" },
          });
        } else {
          await crashWriter.commit({
            op: "D",
            collection: COLLECTION,
            docId: targetId,
          });
        }
      } catch (error) {
        // Either the synthetic AbortError fired mid-commit, or the
        // writer surfaced a `Conflict` from a CAS race the abort
        // induced. Both are expected; the property body proceeds
        // unconditionally.
        if (
          !(error instanceof Error) ||
          !(error.name === "AbortError" || (error as { code?: string }).code === "Conflict")
        ) {
          throw error;
        }
      }

      // Re-run rebuild on each declared index against the clean
      // `inner` view (the writer's CAS either committed to the live
      // pointer or not — `inner` is the source of truth either way).
      for (const def of INDEXES) {
        await rebuildIndex(inner, CURRENT_JSON_KEY, def);
      }

      // Reconstruct the live doc set the reader sees, and assert
      // index parity.
      const live = new Map<string, Doc>();
      // Under single-write commit the writer doesn't advance tail_hint —
      // discover the true tail by forward-probe so the expected live set
      // covers every committed entry.
      const tailProbe = await probeTailFrom(inner, LOG_PREFIX, 0);
      const nextSeq = tailProbe.tail;
      for (let s = 0; s < nextSeq; s++) {
        const got = await inner.get(`${LOG_PREFIX}/log/${s}.json`);
        if (got === null) {
          continue;
        }
        // We won't trip on malformed bodies — the writer only emits
        // valid JSON.
        const entry = JSON.parse(new TextDecoder().decode(got.body)) as {
          op: "I" | "U" | "D";
          doc_id: string;
          after?: Doc;
        };
        if (entry.op === "D") {
          live.delete(entry.doc_id);
        } else if (entry.after !== undefined) {
          live.set(entry.doc_id, entry.after);
        }
      }
      const expected = new Set<string>();
      for (const doc of live.values()) {
        for (const k of allIndexKeysFor(LOG_PREFIX, INDEXES, doc, doc._id)) {
          expected.add(k);
        }
      }
      const actual = new Set<string>();
      for (const def of INDEXES) {
        for (const k of await listIndexKeysFor(inner, def.name)) {
          actual.add(k);
        }
      }
      expect([...actual].toSorted()).toEqual([...expected].toSorted());
    },
    PROP_TIMEOUT_MS,
  );
});
