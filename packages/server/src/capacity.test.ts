/* eslint-disable no-underscore-dangle -- `_id` is the locked primary-key
   field on document shapes. */

/**
 * `capacityRefusal` decision rules (main-10 G3–G5) on hand-built state, and
 * a property test that measures the byte projection against real folds,
 * which is what bounds `CAPACITY_BYTES_MARGIN`. End-to-end behavior through
 * the public write verbs lives in
 * `tests/integration/maintenance-growth-refusal.test.ts`.
 */

import {
  CAPACITY_BYTES_MARGIN,
  createCurrentJson,
  CURRENT_JSON_SCHEMA_VERSION,
  type DocumentData,
  type LogEntry,
  MemoryStorage,
  readCurrentJson,
} from "@baerly/protocol";
import { fc, test as propTest } from "@fast-check/vitest";
import { describe, expect, test } from "vitest";
import { capacityRefusal, type PlannedWrite, projectSnapshot } from "./capacity.ts";
import { compact } from "./compactor.ts";
import { loadSnapshotAsMap } from "./snapshot.ts";
import { Writer } from "./writer.ts";

const COLLECTION = "c";
const ceilings = { maxRows: 10, maxBytes: 100_000 };
const body = (id: string, pad = ""): DocumentData => ({ _id: id, pad });

/** `n` stored rows `d0…d(n-1)` with their exact projected byte total. */
const stored = (n: number, pad = "") => {
  const base = new Map<string, DocumentData>();
  for (let i = 0; i < n; i++) {
    base.set(`d${i}`, body(`d${i}`, pad));
  }
  const p = projectSnapshot({ snapshot_rows: 0, snapshot_bytes: 0 }, new Map(), COLLECTION);
  for (const [id, b] of base) {
    p.apply("I", id, b);
  }
  return { base, head: { snapshot_rows: n, snapshot_bytes: p.bytes } };
};

const entry = (seq: number, op: "I" | "U" | "D", id: string, pad = ""): LogEntry => ({
  lsn: `lsn-${seq}`,
  commit_ts: "2026-01-01T00:00:00.000Z",
  op,
  collection: COLLECTION,
  doc_id: id,
  session: "s",
  seq,
  ...(op === "D" ? {} : { after: body(id, pad) }),
});

const decide = (
  state: ReturnType<typeof stored>,
  tail: LogEntry[],
  writes: PlannedWrite[],
  limits = ceilings,
) =>
  capacityRefusal({
    collection: COLLECTION,
    head: state.head,
    base: state.base,
    tail,
    writes,
    ceilings: limits,
  })?.code;

describe("capacityRefusal", () => {
  const anyWrite: PlannedWrite[] = [
    { op: "I", docId: "new", after: body("new") },
    { op: "D", docId: "d0" },
    { op: "U", docId: "d0", after: body("d0"), before: body("d0") },
  ];

  test("no progress (stored rows > E): every write is refused, deletes included", () => {
    const s = stored(11);
    for (const w of anyWrite) {
      expect(decide(s, [], [w])).toBe("CapacityExceeded");
    }
    expect(decide(s, [], [])).toBeUndefined();
  });

  test("at E with nothing pending, deletes and same-size updates commit; an insert is refused", () => {
    const s = stored(10);
    expect(decide(s, [], [anyWrite[0]!])).toBe("CapacityExceeded");
    expect(decide(s, [], [anyWrite[1]!])).toBeUndefined();
    expect(decide(s, [], [anyWrite[2]!])).toBeUndefined();
  });

  test("no progress (a pending insert the fold stops at): every write is refused", () => {
    // At the tail head, stored rows = E.
    for (const w of anyWrite) {
      expect(decide(stored(10), [entry(10, "I", "p")], [w])).toBe("CapacityExceeded");
    }
    // Mid-tail: the second pending insert is the one that adds a row at E.
    const s = stored(8);
    expect(
      decide(s, [entry(8, "I", "a"), entry(9, "I", "b")], [{ op: "D", docId: "d0" }]),
    ).toBeUndefined();
    expect(
      decide(
        s,
        [entry(8, "I", "a"), entry(9, "I", "b"), entry(10, "I", "c")],
        [{ op: "D", docId: "d0" }],
      ),
    ).toBe("CapacityExceeded");
    // A delete ahead of the insert makes room, so the fold does not stop.
    expect(
      decide(stored(10), [entry(10, "D", "d1"), entry(11, "I", "p")], [{ op: "D", docId: "d0" }]),
    ).toBeUndefined();
  });

  test("no progress (stored bytes > C): a delete is refused", () => {
    const s = stored(3, "x".repeat(100));
    expect(
      decide(s, [], [{ op: "D", docId: "d0" }], {
        maxRows: 10,
        maxBytes: s.head.snapshot_bytes - 1,
      }),
    ).toBe("CapacityExceeded");
  });

  test("rows: an insert is refused exactly when the projected rows reach E", () => {
    const s = stored(8);
    expect(decide(s, [], [{ op: "I", docId: "n", after: body("n") }])).toBeUndefined();
    const pending = [entry(8, "I", "p")];
    expect(decide(s, pending, [{ op: "I", docId: "n", after: body("n") }])).toBe(
      "CapacityExceeded",
    );
  });

  test("rows: the peak over tail prefixes counts, not only the final projection", () => {
    const s = stored(7);
    // +3 to E, then -3: the final projection is 7 + 1, but a fold can land at the peak.
    const tail = [
      entry(7, "I", "a"),
      entry(8, "I", "b"),
      entry(9, "I", "c"),
      entry(10, "D", "a"),
      entry(11, "D", "b"),
      entry(12, "D", "c"),
    ];
    expect(decide(s, tail, [{ op: "I", docId: "n", after: body("n") }])).toBe("CapacityExceeded");
  });

  test("near E, deletes and same-size or shrinking updates commit; a growing update is judged on bytes", () => {
    const s = stored(9, "xx");
    const tail = [entry(9, "I", "p")]; // projected 10 = E
    expect(decide(s, tail, [{ op: "D", docId: "d0" }])).toBeUndefined();
    expect(
      decide(s, tail, [
        { op: "U", docId: "d0", after: body("d0", "yy"), before: body("d0", "xx") },
      ]),
    ).toBeUndefined();
    expect(
      decide(s, tail, [{ op: "U", docId: "d0", after: body("d0"), before: body("d0", "xx") }]),
    ).toBeUndefined();
    // A growing update adds no row, but the tail's peak already sits at E.
    expect(
      decide(s, tail, [
        { op: "U", docId: "d0", after: body("d0", "xxx"), before: body("d0", "xx") },
      ]),
    ).toBe("CapacityExceeded");
  });

  test("bytes: growth is refused past C - CAPACITY_BYTES_MARGIN, not before", () => {
    const s = stored(2, "x".repeat(50));
    const insert = (pad: string): PlannedWrite => ({ op: "I", docId: "n", after: body("n", pad) });
    const p = projectSnapshot(s.head, s.base, COLLECTION);
    p.apply("I", "n", body("n", "x".repeat(40)));
    const fits = { maxRows: 100, maxBytes: p.bytes + CAPACITY_BYTES_MARGIN };
    expect(decide(s, [], [insert("x".repeat(40))], fits)).toBeUndefined();
    expect(decide(s, [], [insert("x".repeat(41))], fits)).toBe("CapacityExceeded");
  });

  test("a batch is decided whole: one growth write past E refuses the batch", () => {
    const s = stored(8);
    const writes: PlannedWrite[] = [
      { op: "I", docId: "a", after: body("a") },
      { op: "I", docId: "b", after: body("b") },
    ];
    expect(decide(s, [], writes.slice(0, 1))).toBeUndefined();
    expect(decide(s, [], writes)).toBe("CapacityExceeded");
  });

  test("tail entries the fold skips are skipped: another collection's, and I / U with no post-image", () => {
    const s = stored(9);
    const foreign = { ...entry(9, "I", "p"), collection: "other" };
    const bodyless: LogEntry = { ...entry(10, "U", "d0"), after: undefined };
    const insert: PlannedWrite = { op: "I", docId: "n", after: body("n") };
    // Neither entry changes the row count, so 9 + 1 = E is the insert itself.
    expect(decide(s, [foreign, bodyless], [insert])).toBe("CapacityExceeded");
    expect(decide(s, [foreign, bodyless], [{ op: "D", docId: "d0" }])).toBeUndefined();
    // With E one higher, the insert fits: the foreign insert was not counted.
    expect(decide(s, [foreign], [insert], { maxRows: 11, maxBytes: 100_000 })).toBeUndefined();
  });

  test("a NaN ceiling fails closed, as the fold gate does", () => {
    const s = stored(1);
    expect(
      decide(s, [], [{ op: "D", docId: "d0" }], { maxRows: Number.NaN, maxBytes: 100_000 }),
    ).toBe("CapacityExceeded");
  });

  test("an update with no known current row counts as growth (fails closed)", () => {
    const s = stored(9);
    const tail = [entry(9, "I", "p")];
    expect(decide(s, tail, [{ op: "U", docId: "d0", after: body("d0") }])).toBe("CapacityExceeded");
  });
});

// ── Projection accuracy against real folds ───────────────────────────
const KEY = "app/a/tenant/t/manifests/c/current.json";
const opArb = fc.record({
  kind: fc.constantFrom("I" as const, "U" as const, "D" as const),
  id: fc.integer({ min: 0, max: 11 }),
  pad: fc.string({ unit: fc.constantFrom("x", "é", "\u{1F600}", '"', "\\"), maxLength: 40 }),
});

describe("projectSnapshot matches the compactor's encoding", () => {
  propTest.prop({
    first: fc.array(opArb, { maxLength: 15 }),
    second: fc.array(opArb, { maxLength: 15 }),
  })(
    "projected rows are exact and projected bytes are within CAPACITY_BYTES_MARGIN of the folded snapshot",
    async ({ first, second }) => {
      const storage = new MemoryStorage();
      await createCurrentJson(storage, KEY, {
        schema_version: CURRENT_JSON_SCHEMA_VERSION,
        snapshot: null,
        tail_hint: 0,
        log_seq_start: 0,
        writer_fence: { epoch: 0, owner: "capacity-test", claimed_at: "" },
        snapshot_bytes: 0,
        snapshot_rows: 0,
      });
      const writer = new Writer({ storage, currentJsonKey: KEY });
      const live = new Set<string>();
      const run = async (ops: typeof first) => {
        const committed: Array<{ op: "I" | "U" | "D"; id: string; after?: DocumentData }> = [];
        for (const { kind, id: n, pad } of ops) {
          const id = `d${n}`;
          // Only valid ops: I on an absent row, U / D on a live one.
          let op: "I" | "U" | "D" = "I";
          if (live.has(id)) {
            op = kind === "I" ? "U" : kind;
          }
          const after = op === "D" ? undefined : body(id, pad);
          await writer.commit({
            op,
            collection: COLLECTION,
            docId: id,
            ...(after !== undefined && { body: after }),
          });
          if (op === "D") {
            live.delete(id);
          } else {
            live.add(id);
          }
          committed.push({ op, id, ...(after !== undefined && { after }) });
        }
        return committed;
      };

      await run(first);
      await compact({ storage, currentJsonKey: KEY }, { minEntriesToCompact: 1 });
      const head = (await readCurrentJson(storage, KEY))!.json;
      const base =
        head.snapshot === null
          ? new Map()
          : await loadSnapshotAsMap(storage, head.snapshot, COLLECTION);

      const projection = projectSnapshot(head, base, COLLECTION);
      const tail = await run(second);
      if (tail.length === 0) {
        return; // no second fold to measure against
      }
      for (const w of tail) {
        projection.apply(w.op, w.id, w.after);
      }
      await compact({ storage, currentJsonKey: KEY }, { minEntriesToCompact: 1 });
      const folded = (await readCurrentJson(storage, KEY))!.json;

      expect(projection.rows).toBe(folded.snapshot_rows);
      expect(Math.abs(projection.bytes - folded.snapshot_bytes)).toBeLessThanOrEqual(
        CAPACITY_BYTES_MARGIN,
      );
    },
  );
});
