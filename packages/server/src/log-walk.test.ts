/**
 * Unit tests for `walkLogRange` / `readLogEntry` / `foldLogEntriesOnto`.
 * Covers seq-order preservation, the concurrency bound, error semantics
 * on missing / malformed entries, the empty range, AbortSignal
 * short-circuit, and the per-doc replace semantics of the canonical
 * log fold (property-based against an independent reference oracle).
 */

import { fc, test } from "@fast-check/vitest";
import {
  BaerlyError,
  MAX_PARALLEL_LOG_READS,
  MemoryStorage,
  type DocumentData,
  type LogEntry,
  type Storage,
  type StorageGetOptions,
  type StorageGetResult,
  type StorageListEntry,
  type StoragePutOptions,
  type StoragePutResult,
} from "@baerly/protocol";
import { describe, expect } from "vitest";
import { seedLogEntries } from "../../../tests/fixtures/log-state.ts";
import { foldLogEntriesOnto, readLogEntry, walkLogRange } from "./log-walk.ts";

const PREFIX = "app/t/tenant/x/manifests/c";

const seedRange = (storage: Storage, from: number, toExclusive: number): Promise<void> =>
  seedLogEntries(storage, PREFIX, from, toExclusive);

/**
 * Storage proxy that observes `get` concurrency and lets the caller
 * inject per-seq latency. Delegates writes / list / delete to the
 * inner store.
 */
class ProbeStorage implements Storage {
  inFlight = 0;
  peakInFlight = 0;
  getCalls: string[] = [];
  /** Seq -> milliseconds of artificial latency. */
  latencyBySeq = new Map<number, number>();
  readonly inner: Storage;
  constructor(inner: Storage) {
    this.inner = inner;
  }

  async get(key: string, opts?: StorageGetOptions): Promise<StorageGetResult | null> {
    this.getCalls.push(key);
    this.inFlight += 1;
    if (this.inFlight > this.peakInFlight) {
      this.peakInFlight = this.inFlight;
    }
    try {
      const match = /\/log\/(\d+)\.json$/.exec(key);
      if (match !== null) {
        const ms = this.latencyBySeq.get(Number(match[1]));
        if (ms !== undefined && ms > 0) {
          await new Promise<void>((r) => setTimeout(r, ms));
        }
      }
      return await this.inner.get(key, opts);
    } finally {
      this.inFlight -= 1;
    }
  }

  async put(key: string, body: Uint8Array, opts?: StoragePutOptions): Promise<StoragePutResult> {
    return this.inner.put(key, body, opts);
  }

  async delete(key: string, opts?: { signal?: AbortSignal }): Promise<void> {
    return this.inner.delete(key, opts);
  }

  list(
    prefix: string,
    opts?: { startAfter?: string; maxKeys?: number; signal?: AbortSignal },
  ): AsyncIterable<StorageListEntry> {
    return this.inner.list(prefix, opts);
  }
}

describe("walkLogRange", () => {
  test("returns entries in seq order even when later entries resolve first", async () => {
    const inner = new MemoryStorage();
    await seedRange(inner, 0, 5);
    const probe = new ProbeStorage(inner);
    // Earlier seqs get more latency than later seqs — out-of-order resolution.
    probe.latencyBySeq.set(0, 30);
    probe.latencyBySeq.set(1, 25);
    probe.latencyBySeq.set(2, 20);
    probe.latencyBySeq.set(3, 10);
    probe.latencyBySeq.set(4, 0);

    const entries = await walkLogRange(probe, PREFIX, 0, 5);
    expect(entries.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4]);
  });

  test("caps concurrent gets at MAX_PARALLEL_LOG_READS", async () => {
    const inner = new MemoryStorage();
    const total = MAX_PARALLEL_LOG_READS * 3 + 5;
    await seedRange(inner, 0, total);
    const probe = new ProbeStorage(inner);
    // Uniform latency so every chunk overlaps fully before resolving.
    for (let s = 0; s < total; s++) {
      probe.latencyBySeq.set(s, 5);
    }

    const entries = await walkLogRange(probe, PREFIX, 0, total);
    expect(entries).toHaveLength(total);
    expect(probe.peakInFlight).toBeLessThanOrEqual(MAX_PARALLEL_LOG_READS);
    expect(probe.getCalls).toHaveLength(total);
  });

  test("returns [] and issues zero GETs for an empty range", async () => {
    const probe = new ProbeStorage(new MemoryStorage());
    const entries = await walkLogRange(probe, PREFIX, 7, 7);
    expect(entries).toEqual([]);
    expect(probe.getCalls).toEqual([]);
  });

  test("returns [] and issues zero GETs when fromSeq > toSeqExclusive", async () => {
    const probe = new ProbeStorage(new MemoryStorage());
    const entries = await walkLogRange(probe, PREFIX, 9, 4);
    expect(entries).toEqual([]);
    expect(probe.getCalls).toEqual([]);
  });

  test("throws Internal when an entry is missing inside the range", async () => {
    const inner = new MemoryStorage();
    await seedRange(inner, 0, 3);
    // Seed 4 but skip 3 — a hole inside [0, 5).
    await seedRange(inner, 4, 5);
    await expect(walkLogRange(inner, PREFIX, 0, 5)).rejects.toMatchObject({
      code: "Internal",
    });
  });

  test("throws InvalidResponse on a malformed body", async () => {
    const inner = new MemoryStorage();
    await inner.put(`${PREFIX}/log/0.json`, new TextEncoder().encode("not json"));
    await expect(walkLogRange(inner, PREFIX, 0, 1)).rejects.toBeInstanceOf(BaerlyError);
    await expect(walkLogRange(inner, PREFIX, 0, 1)).rejects.toMatchObject({
      code: "InvalidResponse",
    });
  });

  test("short-circuits on a pre-aborted signal without issuing GETs", async () => {
    const inner = new MemoryStorage();
    await seedRange(inner, 0, 5);
    const probe = new ProbeStorage(inner);
    const ctrl = new AbortController();
    ctrl.abort(new Error("nope"));
    await expect(walkLogRange(probe, PREFIX, 0, 5, { signal: ctrl.signal })).rejects.toBeDefined();
    expect(probe.getCalls).toEqual([]);
  });

  test("stops dispatching further chunks once aborted mid-walk", async () => {
    const inner = new MemoryStorage();
    const total = MAX_PARALLEL_LOG_READS * 4;
    await seedRange(inner, 0, total);
    const probe = new ProbeStorage(inner);
    // Slow every read so the first chunk is still in flight when we abort.
    for (let s = 0; s < total; s++) {
      probe.latencyBySeq.set(s, 20);
    }
    const ctrl = new AbortController();
    // Abort during the first chunk.
    setTimeout(() => ctrl.abort(new Error("stop")), 5);

    await expect(
      walkLogRange(probe, PREFIX, 0, total, { signal: ctrl.signal }),
    ).rejects.toBeDefined();
    // First chunk's GETs raced past the pre-chunk abort check; later
    // chunks must NOT have dispatched.
    expect(probe.getCalls.length).toBeLessThan(total);
    expect(probe.getCalls.length).toBeLessThanOrEqual(MAX_PARALLEL_LOG_READS);
  });
});

describe("readLogEntry", () => {
  test("returns the parsed entry for a present key", async () => {
    const inner = new MemoryStorage();
    await seedRange(inner, 5, 6);
    const entry = await readLogEntry(inner, `${PREFIX}/log/5.json`);
    expect(entry.seq).toBe(5);
    expect(entry.op).toBe("I");
  });

  test("throws Internal when the key resolves to null", async () => {
    const inner = new MemoryStorage();
    await expect(readLogEntry(inner, `${PREFIX}/log/missing.json`)).rejects.toMatchObject({
      code: "Internal",
    });
  });

  test("throws InvalidResponse on a malformed body", async () => {
    const inner = new MemoryStorage();
    await inner.put(`${PREFIX}/log/0.json`, new TextEncoder().encode("{not json"));
    await expect(readLogEntry(inner, `${PREFIX}/log/0.json`)).rejects.toMatchObject({
      code: "InvalidResponse",
    });
  });
});

const FOLD_COLLECTION = "tickets";

// Minimal valid LogEntry. fold reads only op/collection/doc_id/after; the
// other required fields (lsn/commit_ts/session/seq) are filled with stable
// dummies so the object typechecks without `as`.
const foldEntry = (
  op: "I" | "U" | "D",
  docId: string,
  opts: { after?: DocumentData; collection?: string } = {},
): LogEntry => ({
  lsn: `t_s_${docId}`,
  commit_ts: "1970-01-01T00:00:00.000Z",
  op,
  collection: opts.collection ?? FOLD_COLLECTION,
  doc_id: docId,
  session: "s",
  seq: 0,
  ...(opts.after !== undefined && { after: opts.after }),
});

const docIdArb = fc.constantFrom("a", "b", "c", "d");
const bodyArb: fc.Arbitrary<DocumentData> = fc.record({ v: fc.integer({ min: 0, max: 9 }) });

const entryArb: fc.Arbitrary<LogEntry> = fc.oneof(
  // I/U with a defined post-image
  fc
    .record({
      op: fc.constantFrom("I", "U") as fc.Arbitrary<"I" | "U">,
      id: docIdArb,
      after: bodyArb,
    })
    .map((r) => foldEntry(r.op, r.id, { after: r.after })),
  // I/U with NO after (forward-compat patch-only shape — must be skipped)
  fc
    .record({ op: fc.constantFrom("I", "U") as fc.Arbitrary<"I" | "U">, id: docIdArb })
    .map((r) => foldEntry(r.op, r.id)),
  // D tombstone
  docIdArb.map((id) => foldEntry("D", id)),
  // foreign-collection entry (must be ignored)
  fc
    .record({
      op: fc.constantFrom("I", "U") as fc.Arbitrary<"I" | "U">,
      id: docIdArb,
      after: bodyArb,
    })
    .map((r) => foldEntry(r.op, r.id, { after: r.after, collection: "other" })),
);

const entriesArb = fc.array(entryArb, { minLength: 0, maxLength: 40 });

// Independent reference fold — written to spec, not copied from the impl.
const referenceFold = (
  entries: ReadonlyArray<LogEntry>,
  collection: string,
  filter?: ReadonlySet<string>,
): Map<string, DocumentData> => {
  const m = new Map<string, DocumentData>();
  for (const e of entries) {
    if (e.collection !== collection) {
      continue;
    }
    if (filter !== undefined && !filter.has(e.doc_id)) {
      continue;
    }
    if (e.op === "D") {
      m.delete(e.doc_id);
    } else if (e.after !== undefined) {
      m.set(e.doc_id, e.after);
    }
  }
  return m;
};

const runFold = (
  entries: ReadonlyArray<LogEntry>,
  opts: { collection: string; docIdFilter?: ReadonlySet<string> },
): Map<string, DocumentData> => {
  const m = new Map<string, DocumentData>();
  foldLogEntriesOnto(m, entries, opts);
  return m;
};

describe("foldLogEntriesOnto — per-doc replace semantics", () => {
  test.prop({ entries: entriesArb })("matches the spec reference fold", ({ entries }) => {
    expect(runFold(entries, { collection: FOLD_COLLECTION })).toEqual(
      referenceFold(entries, FOLD_COLLECTION),
    );
  });

  test.prop({ entries: entriesArb })(
    "collection scoping: full fold == fold of the matching-collection subset",
    ({ entries }) => {
      const subset = entries.filter((e) => e.collection === FOLD_COLLECTION);
      expect(runFold(entries, { collection: FOLD_COLLECTION })).toEqual(
        runFold(subset, { collection: FOLD_COLLECTION }),
      );
    },
  );

  test.prop({ entries: entriesArb, ids: fc.subarray(["a", "b", "c", "d"]) })(
    "docIdFilter scoping: filtered fold == fold of the filter subset",
    ({ entries, ids }) => {
      const filter = new Set(ids);
      const subset = entries.filter((e) => filter.has(e.doc_id));
      expect(runFold(entries, { collection: FOLD_COLLECTION, docIdFilter: filter })).toEqual(
        runFold(subset, { collection: FOLD_COLLECTION }),
      );
    },
  );

  test.prop({ entries: entriesArb })(
    "after===undefined on I/U is a no-op: dropping those entries is invisible",
    ({ entries }) => {
      const withDefinedAfterOnly = entries.filter((e) => e.op === "D" || e.after !== undefined);
      expect(runFold(entries, { collection: FOLD_COLLECTION })).toEqual(
        runFold(withDefinedAfterOnly, { collection: FOLD_COLLECTION }),
      );
    },
  );

  // ── Concrete hand-checked cases ──

  test("order sensitivity: [I a, D a] ⇒ absent", () => {
    const m = runFold([foldEntry("I", "a", { after: { v: 1 } }), foldEntry("D", "a")], {
      collection: FOLD_COLLECTION,
    });
    expect(m.has("a")).toBe(false);
  });

  test("order sensitivity: [D a, I a] ⇒ present with last image", () => {
    const m = runFold([foldEntry("D", "a"), foldEntry("I", "a", { after: { v: 7 } })], {
      collection: FOLD_COLLECTION,
    });
    expect(m.get("a")).toEqual({ v: 7 });
  });

  test("last-writer-wins across multiple updates", () => {
    const m = runFold(
      [
        foldEntry("I", "a", { after: { v: 1 } }),
        foldEntry("U", "a", { after: { v: 2 } }),
        foldEntry("U", "a", { after: { v: 3 } }),
      ],
      { collection: FOLD_COLLECTION },
    );
    expect(m.get("a")).toEqual({ v: 3 });
  });

  test("foreign-collection entries are ignored", () => {
    const m = runFold([foldEntry("I", "a", { after: { v: 1 }, collection: "other" })], {
      collection: FOLD_COLLECTION,
    });
    expect(m.size).toBe(0);
  });
});
