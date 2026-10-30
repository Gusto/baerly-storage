/* eslint-disable no-underscore-dangle -- `_id` is the locked
   primary-key field on document shapes (see `@baerly/protocol`'s
   `Collection<T>`); this property test threads it through the writer. */

/**
 * Property-based test for the writer + secondary-index data plane.
 *
 * Drives any fast-check sequence of I/U/D ops through a
 * `Writer` configured with two indexes (`by_status`,
 * `by_assignee`) and asserts the load-bearing invariant: after the
 * sequence settles, the set of live index keys on storage equals
 * the set of keys the live doc set projects under
 * `allIndexKeysFor`, PLUS the stale markers the writer is documented
 * to leave behind when a doc's prior post-image is more than
 * `PREIMAGE_SCAN_MAX_GETS` commits back (`docs/spec/sync-protocol.md`
 * invariant 7: an accepted benign false positive, reconciled by
 * `rebuildIndex`). The oracle mirrors that cap exactly: a stale marker
 * is expected iff the superseding write missed the pre-image, and any
 * stale marker within the cap still fails the property. The model is a
 * plain `Map<_id, doc>`; the
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
 * Runtime: default `numRuns: 100` with ≤30 ops × ≤3 PUTs each over
 * `MemoryStorage` ≈ <1 s total. Stays well inside the
 * `pnpm test` budget. Also runs at `FC_NUM_RUNS=10000` under
 * `pnpm test:randomize`.
 */

import { fc, test } from "@fast-check/vitest";
import { describe, expect, test as unitTest } from "vitest";

/**
 * Per-property timeout, in ms. At `FC_NUM_RUNS=100` (default
 * `pnpm test`) each run finishes in well under a second; at
 * `FC_NUM_RUNS=10000` (`pnpm test:randomize`) the property
 * exercises ~10k commits × ~3 PUTs each over `MemoryStorage`
 * and lands in a few seconds even on a busy CI box. The default
 * vitest timeout (5000ms) is far too tight when other heavy
 * property tests are co-resident; mirror `maintenance-crash-fuzz`'s
 * pattern with a comfortable upper bound.
 */
const PROP_TIMEOUT_MS = 600_000;
import {
  CURRENT_JSON_SCHEMA_VERSION,
  createCurrentJson,
  type DocumentData,
  MemoryStorage,
  PREIMAGE_SCAN_MAX_GETS,
} from "@baerly/protocol";
import { allIndexKeysFor, type IndexDefinition } from "./indexes.ts";
import { Writer } from "./writer.ts";

// `assignee` is intentionally absent from the declared shape — the
// "missing field" case is one of the load-bearing arms of the
// property and must be encoded by OMITTING the key from the
// literal. Adding `assignee?` here would force `"alice" | "bob" |
// undefined`, which the `[k: string]: DocumentValue` index
// signature rejects (no undefined in JSON values).
type Doc = DocumentData & { _id: string; status: "open" | "closed" | "wip" };

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

type Op =
  | { kind: "I" | "U"; id: string; status: Doc["status"]; assignee: "alice" | "bob" | undefined }
  | { kind: "D"; id: string };

/**
 * Runs `ops` through a fresh `Writer` and returns the index markers on
 * storage next to the oracle's expectation: live-doc projections plus
 * the stale markers left by commits whose pre-image walk (the last
 * `PREIMAGE_SCAN_MAX_GETS` log seqs) could not reach the doc's prior
 * write.
 */
async function runOps(ops: ReadonlyArray<Op>): Promise<{ actual: string[]; expected: string[] }> {
  const storage = new MemoryStorage();
  await createCurrentJson(storage, CURRENT_JSON_KEY, {
    schema_version: CURRENT_JSON_SCHEMA_VERSION,
    snapshot: null,
    tail_hint: 0,
    log_seq_start: 0,
    writer_fence: { epoch: 0, owner: "test", claimed_at: "" },
    snapshot_bytes: 0,
    snapshot_rows: 0,
  });
  const writer = new Writer({
    storage,
    currentJsonKey: CURRENT_JSON_KEY,
    options: { indexes: INDEXES },
  });

  // Model: plain map of live docs keyed by _id. Mirrors what the
  // reader would observe after the writer's CAS landed.
  const live = new Map<string, Doc>();
  // Last commit per doc (seq + image; `undefined` image = deleted).
  // The writer's pre-image walk reaches it iff it is within the cap.
  const last = new Map<string, { seq: number; image: Doc | undefined }>();
  // Stale markers per doc the writer is expected to have left behind.
  const stale = new Map<string, Set<string>>();
  let nextSeq = 0;

  const keysOf = (doc: Doc | undefined): Set<string> =>
    doc === undefined ? new Set() : new Set(allIndexKeysFor(LOG_PREFIX, INDEXES, doc, doc._id));

  const settle = (id: string, next: Doc | undefined): void => {
    const seq = nextSeq++;
    const prior = last.get(id);
    const newKeys = keysOf(next);
    const staleKeys = stale.get(id) ?? new Set<string>();
    for (const k of newKeys) {
      staleKeys.delete(k); // re-PUT: the marker is live again
    }
    // Pre-image found within the cap: the writer deletes
    // `oldKeys \ newKeys`. Missed: those markers stay behind.
    if (prior !== undefined && seq - prior.seq > PREIMAGE_SCAN_MAX_GETS) {
      for (const k of keysOf(prior.image)) {
        if (!newKeys.has(k)) {
          staleKeys.add(k);
        }
      }
    }
    stale.set(id, staleKeys);
    last.set(id, { seq, image: next });
  };

  for (const op of ops) {
    if (op.kind === "D") {
      // Skip if the writer would reject the D.
      if (!live.has(op.id)) {
        continue;
      }
      await writer.commit({ op: "D", collection: COLLECTION, docId: op.id });
      live.delete(op.id);
      settle(op.id, undefined);
      continue;
    }
    // Skip I-on-existing and U-on-missing (single writer here).
    if (op.kind === "I" ? live.has(op.id) : !live.has(op.id)) {
      continue;
    }
    const doc: Doc =
      op.assignee === undefined
        ? { _id: op.id, status: op.status }
        : { _id: op.id, status: op.status, assignee: op.assignee };
    await writer.commit({ op: op.kind, collection: COLLECTION, docId: op.id, body: doc });
    live.set(op.id, doc);
    settle(op.id, doc);
  }

  // Expected: live projections plus the stale markers the cap allows.
  const expected = new Set<string>();
  for (const doc of live.values()) {
    for (const k of keysOf(doc)) {
      expected.add(k);
    }
  }
  for (const keys of stale.values()) {
    for (const k of keys) {
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
  return { actual: [...actual].toSorted(), expected: [...expected].toSorted() };
}

describe("Writer + indexes: live index keys reflect live doc set", () => {
  test.prop({ ops: fc.array(opArb, { minLength: 0, maxLength: 30 }) })(
    "after N ops, live index keys = projection of live doc set + cap-allowed stale markers",
    async ({ ops }) => {
      const { actual, expected } = await runOps(ops);
      expect(actual).toEqual(expected);
    },
    PROP_TIMEOUT_MS,
  );

  // Regression for fast-check seed -614776092: `c` is written at seq 0
  // and deleted at seq 9, so the delete's walk (seqs 1..8) misses the
  // pre-image and `c`'s marker is a documented stale key, not a defect.
  unitTest("a marker whose superseding write is beyond the cap stays stale", async () => {
    const open = { status: "open" as const, assignee: undefined };
    const ops: Op[] = [
      { kind: "I", id: "c", ...open },
      { kind: "I", id: "a", ...open },
      { kind: "I", id: "b", ...open },
      { kind: "U", id: "a", ...open },
      { kind: "D", id: "a" },
      { kind: "I", id: "a", ...open },
      { kind: "U", id: "a", ...open },
      { kind: "U", id: "a", ...open },
      { kind: "U", id: "a", ...open },
      { kind: "D", id: "c" },
    ];
    const { actual, expected } = await runOps(ops);
    expect(PREIMAGE_SCAN_MAX_GETS).toBeLessThan(9); // gap 9 must exceed the cap
    expect(actual).toEqual(expected);
    expect(actual.some((k) => k.endsWith("/c.json"))).toBe(true);
  });

  // Gap == cap is reachable, so the stale marker must be deleted.
  unitTest("a marker whose superseding write is exactly at the cap is deleted", async () => {
    const open = { status: "open" as const, assignee: undefined };
    const ops: Op[] = [{ kind: "I", id: "c", ...open }];
    for (let i = 1; i < PREIMAGE_SCAN_MAX_GETS; i++) {
      ops.push({ kind: "I", id: `x${i}`, ...open });
    }
    ops.push({ kind: "D", id: "c" }); // seq == cap, gap == cap
    const { actual, expected } = await runOps(ops);
    expect(actual).toEqual(expected);
    expect(actual.some((k) => k.endsWith("/c.json"))).toBe(false);
  });
});
