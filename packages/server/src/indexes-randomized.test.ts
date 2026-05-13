/* eslint-disable no-underscore-dangle -- `_id` is the locked
   primary-key field on document shapes (see `@baerly/protocol`'s
   `Table<T>`); this property test threads it through the writer. */

/**
 * Property-based test for the writer + secondary-index data plane.
 *
 * Drives any fast-check sequence of I/U/D ops through a
 * `ServerWriter` configured with two indexes (`by_status`,
 * `by_assignee`) and asserts the load-bearing invariant: after the
 * sequence settles, the set of live index keys on storage equals
 * the set of keys the live doc set projects under
 * `allIndexKeysFor`. The model is a plain `Map<_id, doc>`; the
 * fast-check command stream skips ops that the writer would
 * reject (insert-on-existing-id, U/D-on-missing) so the invariant
 * is meaningful on every shrink.
 *
 * Coverage:
 *   - I  → fresh index keys land for every declared index whose
 *          projected field is set.
 *   - U  → keys reflect the NEW value; stale keys from the
 *          pre-image are gone.
 *   - D  → every projected key for the doc's last image is gone.
 *   - skipping the field (assignee absent) skips that index's
 *     key for that doc.
 *
 * Runtime: default `numRuns: 100` with ≤30 ops × ≤4 PUTs each over
 * `MemoryStorage` ≈ <1 s total. Stays well inside the
 * `pnpm test` budget. Also runs at `FC_NUM_RUNS=10000` under
 * `pnpm test:randomize`.
 */

import { fc, test } from "@fast-check/vitest";
import { describe, expect } from "vitest";

/**
 * Per-property timeout, in ms. At `FC_NUM_RUNS=100` (default
 * `pnpm test`) each run finishes in well under a second; at
 * `FC_NUM_RUNS=10000` (`pnpm test:randomize`) the property
 * exercises ~10k commits × ~4 PUTs each over `MemoryStorage`
 * and lands in a few seconds even on a busy CI box. The default
 * vitest timeout (5000ms) is far too tight when other heavy
 * property tests are co-resident; mirror `phase5-crash-fuzz`'s
 * pattern with a comfortable upper bound.
 */
const PROP_TIMEOUT_MS = 600_000;
import {
  CURRENT_JSON_SCHEMA_VERSION,
  createCurrentJson,
  type JSONArraylessObject,
  MemoryStorage,
} from "@baerly/protocol";
import { allIndexKeysFor, type IndexDefinition } from "./indexes.ts";
import { ServerWriter } from "./server-writer.ts";

// `assignee` is intentionally absent from the declared shape — the
// "missing field" case is one of the load-bearing arms of the
// property and must be encoded by OMITTING the key from the
// literal. Adding `assignee?` here would force `"alice" | "bob" |
// undefined`, which the `[k: string]: JSONArrayless` index
// signature rejects (no undefined in JSON values).
type Doc = JSONArraylessObject & { _id: string; status: "open" | "closed" | "wip" };

const INDEXES: ReadonlyArray<IndexDefinition> = [
  { name: "by_status", on: "status" },
  { name: "by_assignee", on: "assignee" },
];

const CURRENT_JSON_KEY = "app/x/tenant/t/manifests/tickets/current.json";
const LOG_PREFIX = "app/x/tenant/t/manifests/tickets";
const COLLECTION = "tickets";

const opArb = fc.oneof(
  fc.record({
    kind: fc.constant("I" as const),
    id: fc.constantFrom("a", "b", "c"),
    status: fc.constantFrom("open" as const, "closed" as const, "wip" as const),
    assignee: fc.option(fc.constantFrom("alice" as const, "bob" as const), { nil: undefined }),
  }),
  fc.record({
    kind: fc.constant("U" as const),
    id: fc.constantFrom("a", "b", "c"),
    status: fc.constantFrom("open" as const, "closed" as const, "wip" as const),
    assignee: fc.option(fc.constantFrom("alice" as const, "bob" as const), { nil: undefined }),
  }),
  fc.record({
    kind: fc.constant("D" as const),
    id: fc.constantFrom("a", "b", "c"),
  }),
);

describe("ServerWriter + indexes: live index keys reflect live doc set", () => {
  test.prop({ ops: fc.array(opArb, { minLength: 0, maxLength: 30 }) })(
    "after N ops, live index keys = projection of live doc set",
    async ({ ops }) => {
      const storage = new MemoryStorage();
      await createCurrentJson(storage, CURRENT_JSON_KEY, {
        schema_version: CURRENT_JSON_SCHEMA_VERSION,
        snapshot: null,
        next_seq: 0,
        writer_fence: { epoch: 0, owner: "test", claimed_at: "" },
      });
      const writer = new ServerWriter({
        storage,
        currentJsonKey: CURRENT_JSON_KEY,
        options: { indexes: INDEXES },
      });

      // Model: plain map of live docs keyed by _id. Mirrors what the
      // reader would observe after the writer's CAS landed.
      const live = new Map<string, Doc>();

      for (const op of ops) {
        if (op.kind === "I") {
          // Skip if the writer would reject the I (we're single-writer
          // here so a duplicate _id at this layer is the same).
          if (live.has(op.id)) continue;
          const doc: Doc =
            op.assignee === undefined
              ? { _id: op.id, status: op.status }
              : { _id: op.id, status: op.status, assignee: op.assignee };
          await writer.commit({
            op: "I",
            collection: COLLECTION,
            docId: op.id,
            body: doc,
          });
          live.set(op.id, doc);
        } else if (op.kind === "U") {
          if (!live.has(op.id)) continue;
          const doc: Doc =
            op.assignee === undefined
              ? { _id: op.id, status: op.status }
              : { _id: op.id, status: op.status, assignee: op.assignee };
          await writer.commit({
            op: "U",
            collection: COLLECTION,
            docId: op.id,
            body: doc,
          });
          live.set(op.id, doc);
        } else {
          if (!live.has(op.id)) continue;
          await writer.commit({
            op: "D",
            collection: COLLECTION,
            docId: op.id,
          });
          live.delete(op.id);
        }
      }

      // Expected: union of projected keys across every live doc.
      const expected = new Set<string>();
      for (const doc of live.values()) {
        for (const k of allIndexKeysFor(LOG_PREFIX, INDEXES, doc, doc._id)) {
          expected.add(k);
        }
      }
      // Actual: every key on storage under each index's prefix.
      const actual = new Set<string>();
      for (const def of INDEXES) {
        for await (const entry of storage.list(`${LOG_PREFIX}/index/${def.name}/`)) {
          actual.add(entry.key);
        }
      }
      expect([...actual].toSorted()).toEqual([...expected].toSorted());
    },
    PROP_TIMEOUT_MS,
  );
});
