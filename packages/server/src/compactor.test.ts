/* eslint-disable no-underscore-dangle -- `_id` is the locked primary-key
   field on document shapes (see `@baerly/protocol/src/collection-api.ts`'s `Collection<T>`
   declaration); snapshot body docs carry it through. */

/**
 * Compactor — `compact()` happy paths and invariants under
 * `MemoryStorage`. The cross-adapter coverage (memory / local-fs /
 * node-minio / cloudflare-r2) is exercised by the `[compaction]`
 * variant inside `tests/fixtures/collection-api-cascade.ts`.
 */

import {
  createCurrentJson,
  MemoryStorage,
  BaerlyError,
  readCurrentJson,
  type Storage,
  type StoragePutOptions,
  type StoragePutResult,
} from "@baerly/protocol";
import { describe, expect, test } from "vitest";
import { fc, test as fcTest } from "@fast-check/vitest";
import { logStateCurrentJson } from "../../../tests/fixtures/log-state.ts";
import { compact, type InternalCompactOptions } from "./compactor.ts";
import { loadSnapshotAsMap } from "./snapshot.ts";
import { createObservabilityContext, runWithContext } from "./observability/index.ts";
import { runGc } from "./gc.ts";
import { Writer } from "./writer.ts";

const bootstrap = async (storage: MemoryStorage, key: string): Promise<void> => {
  await createCurrentJson(
    storage,
    key,
    logStateCurrentJson({ writer_fence: { epoch: 0, owner: "compactor-test", claimed_at: "" } }),
  );
};

describe("compact", () => {
  const KEY = "app/t/tenant/x/manifests/c/current.json";
  const COLL = "c";

  test("returns current-json-missing when current.json doesn't exist", async () => {
    const s = new MemoryStorage();
    const res = await compact({ storage: s, currentJsonKey: KEY });
    expect(res.written).toBe(false);
    expect(res.skippedReason).toBe("current-json-missing");
    expect(res.previousSnapshotKey).toBeNull();
    expect(res.entriesFolded).toBe(0);
  });

  test("skips when below min threshold", async () => {
    const s = new MemoryStorage();
    await bootstrap(s, KEY);
    const writer = new Writer({ storage: s, currentJsonKey: KEY });
    for (let i = 0; i < 5; i++) {
      await writer.commit({
        op: "I",
        collection: COLL,
        docId: `d${i}`,
        body: { _id: `d${i}`, n: i },
      });
    }
    const res = await compact({ storage: s, currentJsonKey: KEY }, { minEntriesToCompact: 10 });
    expect(res.written).toBe(false);
    expect(res.skippedReason).toBe("below-min-threshold");
    expect(res.previousSnapshotKey).toBeNull();
    expect(res.logSeqStartBefore).toBe(0);
    expect(res.logSeqStartAfter).toBe(0);
    expect(res.entriesFolded).toBe(0);
  });

  test("writes a snapshot and advances log_seq_start", async () => {
    const s = new MemoryStorage();
    await bootstrap(s, KEY);
    const writer = new Writer({ storage: s, currentJsonKey: KEY });
    for (let i = 0; i < 50; i++) {
      await writer.commit({
        op: "I",
        collection: COLL,
        docId: `d${i}`,
        body: { _id: `d${i}`, n: i },
      });
    }
    const res = await compact({ storage: s, currentJsonKey: KEY }, {
      minEntriesToCompact: 10,
      maxEntriesPerRun: 40,
    } as InternalCompactOptions);
    expect(res.written).toBe(true);
    expect(res.entriesFolded).toBe(40);
    expect(res.logSeqStartBefore).toBe(0);
    expect(res.logSeqStartAfter).toBe(40);
    expect(res.previousSnapshotKey).toBeNull();
    expect(res.newSnapshotKey).toBeDefined();
    // L9/<12-digit min>-<12-digit max>-<64 hex>.json under collectionPrefix.
    expect(res.newSnapshotKey).toMatch(/\/snapshot\/L9\/0{12}-0{10}40-[0-9a-f]{64}\.json$/);
  });

  test("is idempotent: re-running with no new writes is a no-op", async () => {
    const s = new MemoryStorage();
    await bootstrap(s, KEY);
    const writer = new Writer({ storage: s, currentJsonKey: KEY });
    // 50 entries, fold them all in one shot so no live tail remains.
    for (let i = 0; i < 50; i++) {
      await writer.commit({
        op: "I",
        collection: COLL,
        docId: `d${i}`,
        body: { _id: `d${i}`, n: i },
      });
    }
    const a = await compact({ storage: s, currentJsonKey: KEY }, {
      minEntriesToCompact: 10,
      maxEntriesPerRun: 100,
    } as InternalCompactOptions);
    expect(a.written).toBe(true);
    expect(a.logSeqStartAfter).toBe(50);
    // With log_seq_start now at 50 and no new writes, the live-tail
    // length is 0 < minEntriesToCompact → skip.
    const b = await compact({ storage: s, currentJsonKey: KEY }, {
      minEntriesToCompact: 10,
      maxEntriesPerRun: 100,
    } as InternalCompactOptions);
    expect(b.written).toBe(false);
    expect(b.skippedReason).toBe("below-min-threshold");
    expect(b.previousSnapshotKey).toBe(a.newSnapshotKey);
  });

  test("subsequent run extends the snapshot when new writes have landed", async () => {
    const s = new MemoryStorage();
    await bootstrap(s, KEY);
    const writer = new Writer({ storage: s, currentJsonKey: KEY });
    for (let i = 0; i < 40; i++) {
      await writer.commit({
        op: "I",
        collection: COLL,
        docId: `d${i}`,
        body: { _id: `d${i}`, n: i },
      });
    }
    const first = await compact({ storage: s, currentJsonKey: KEY }, {
      minEntriesToCompact: 10,
      maxEntriesPerRun: 40,
    } as InternalCompactOptions);
    expect(first.written).toBe(true);

    for (let i = 40; i < 80; i++) {
      await writer.commit({
        op: "I",
        collection: COLL,
        docId: `d${i}`,
        body: { _id: `d${i}`, n: i },
      });
    }
    const res = await compact({ storage: s, currentJsonKey: KEY }, {
      minEntriesToCompact: 10,
      maxEntriesPerRun: 40,
    } as InternalCompactOptions);
    expect(res.written).toBe(true);
    expect(res.logSeqStartBefore).toBe(40);
    expect(res.logSeqStartAfter).toBe(80);
    expect(res.entriesFolded).toBe(40);
    expect(res.previousSnapshotKey).toBe(first.newSnapshotKey);

    // The extended snapshot contains all 80 rows (carried forward via
    // the prior-snapshot fold base).
    const map = await loadSnapshotAsMap(s, res.newSnapshotKey!, COLL);
    expect(map.size).toBe(80);
  });

  test("snapshot body hash matches the filename hash", async () => {
    const s = new MemoryStorage();
    await bootstrap(s, KEY);
    const writer = new Writer({ storage: s, currentJsonKey: KEY });
    for (let i = 0; i < 50; i++) {
      await writer.commit({
        op: "I",
        collection: COLL,
        docId: `d${i}`,
        body: { _id: `d${i}`, n: i },
      });
    }
    const res = await compact({ storage: s, currentJsonKey: KEY }, { minEntriesToCompact: 10 });
    expect(res.newSnapshotKey).toBeDefined();
    // `loadSnapshotAsMap` throws Internal on hash mismatch; if this
    // returns, the recompute over the body equals the filename hash.
    // The default `maxEntriesPerRun` is effectively unbounded, so
    // all 50 entries get folded in one pass.
    const map = await loadSnapshotAsMap(s, res.newSnapshotKey!, COLL);
    expect(map.size).toBe(50);
  });

  test("rejects a snapshot whose body has been tampered with", async () => {
    const s = new MemoryStorage();
    await bootstrap(s, KEY);
    const writer = new Writer({ storage: s, currentJsonKey: KEY });
    for (let i = 0; i < 50; i++) {
      await writer.commit({
        op: "I",
        collection: COLL,
        docId: `d${i}`,
        body: { _id: `d${i}`, n: i },
      });
    }
    const res = await compact({ storage: s, currentJsonKey: KEY }, { minEntriesToCompact: 10 });
    expect(res.newSnapshotKey).toBeDefined();
    // Overwrite with a different body (an empty `{}` JSON object).
    // Body's actual SHA-256 will no longer match the filename's
    // embedded hash → `loadSnapshotAsMap` throws Internal.
    await s.put(res.newSnapshotKey!, new TextEncoder().encode("{}"), {
      contentType: "application/json",
    });
    await expect(loadSnapshotAsMap(s, res.newSnapshotKey!, COLL)).rejects.toThrow(/hash mismatch/);
  });

  test("treats a snapshot pointer with no body as a protocol violation", async () => {
    const s = new MemoryStorage();
    // Hand-craft a snapshot key (valid shape, but the body was never
    // PUT). `loadSnapshotAsMap` should throw Internal.
    const key =
      "app/t/tenant/x/manifests/c/snapshot/L9/000000000000-000000000040-" +
      "a".repeat(64) +
      ".json";
    await expect(loadSnapshotAsMap(s, key, COLL)).rejects.toMatchObject({
      code: "Internal",
    });
  });

  test("delete tombstones drop docs from the snapshot fold", async () => {
    const s = new MemoryStorage();
    await bootstrap(s, KEY);
    const writer = new Writer({ storage: s, currentJsonKey: KEY });
    await writer.commit({ op: "I", collection: COLL, docId: "a", body: { _id: "a" } });
    await writer.commit({ op: "I", collection: COLL, docId: "b", body: { _id: "b" } });
    await writer.commit({ op: "D", collection: COLL, docId: "a" });
    // Pad up to the compaction threshold.
    for (let i = 0; i < 10; i++) {
      await writer.commit({
        op: "I",
        collection: COLL,
        docId: `pad${i}`,
        body: { _id: `pad${i}` },
      });
    }
    const res = await compact({ storage: s, currentJsonKey: KEY }, { minEntriesToCompact: 5 });
    expect(res.written).toBe(true);
    const map = await loadSnapshotAsMap(s, res.newSnapshotKey!, COLL);
    expect(map.has("a")).toBe(false);
    expect(map.has("b")).toBe(true);
  });

  test("rejects a snapshot body that names a different collection", async () => {
    const s = new MemoryStorage();
    await bootstrap(s, KEY);
    const writer = new Writer({ storage: s, currentJsonKey: KEY });
    for (let i = 0; i < 50; i++) {
      await writer.commit({
        op: "I",
        collection: COLL,
        docId: `d${i}`,
        body: { _id: `d${i}` },
      });
    }
    const res = await compact({ storage: s, currentJsonKey: KEY }, { minEntriesToCompact: 10 });
    expect(res.newSnapshotKey).toBeDefined();
    await expect(
      loadSnapshotAsMap(s, res.newSnapshotKey!, "other-collection"),
    ).rejects.toMatchObject({ code: "InvalidResponse" });
  });

  test("emits db.compact.entries_folded and db.manifest.lag_window_depth on success", async () => {
    const s = new MemoryStorage();
    await bootstrap(s, KEY);
    const writer = new Writer({ storage: s, currentJsonKey: KEY });
    for (let i = 0; i < 50; i++) {
      await writer.commit({
        op: "I",
        collection: COLL,
        docId: `d${i}`,
        body: { _id: `d${i}`, n: i },
      });
    }
    const ctx = createObservabilityContext();
    let res!: Awaited<ReturnType<typeof compact>>;
    await runWithContext(ctx, async () => {
      res = await compact({ storage: s, currentJsonKey: KEY }, {
        minEntriesToCompact: 10,
        maxEntriesPerRun: 40,
      } as InternalCompactOptions);
    });
    expect(res.written).toBe(true);
    const snap = ctx.recorder.snapshot();
    // Folded 40 of the 50 available.
    expect(snap.histograms.filter((h) => h.name === "db.compact.entries_folded")).toEqual([
      { name: "db.compact.entries_folded", value: 40, labels: { collection: COLL } },
    ]);
    // Live tail after fold = 50 (next_seq) - 40 (foldEnd) = 10.
    const lag = snap.gauges.findLast((g) => g.name === "db.manifest.lag_window_depth");
    expect(lag?.value).toBe(10);
  });

  test("emits no metrics when run is skipped (below-min-threshold)", async () => {
    const s = new MemoryStorage();
    await bootstrap(s, KEY);
    const ctx = createObservabilityContext();
    let res!: Awaited<ReturnType<typeof compact>>;
    await runWithContext(ctx, async () => {
      res = await compact({ storage: s, currentJsonKey: KEY }, { minEntriesToCompact: 10 });
    });
    expect(res.written).toBe(false);
    const snap = ctx.recorder.snapshot();
    expect(snap.histograms.filter((h) => h.name === "db.compact.entries_folded")).toEqual([]);
    expect(snap.gauges.find((g) => g.name === "db.manifest.lag_window_depth")).toBeUndefined();
  });

  test("surfaces a missing log entry inside the fold window as Internal", async () => {
    const s = new MemoryStorage();
    // Hand-craft a current.json claiming 10 log entries exist but
    // never plant the bodies. compact() walks [0, 10) and should
    // throw Internal on the first missing GET.
    await createCurrentJson(s, KEY, logStateCurrentJson({ next_seq: 10 }));
    await expect(
      compact({ storage: s, currentJsonKey: KEY }, { minEntriesToCompact: 5 }),
    ).rejects.toMatchObject({ code: "Internal" });
    // The error message names the missing key prefix.
    try {
      await compact({ storage: s, currentJsonKey: KEY }, { minEntriesToCompact: 5 });
    } catch (error) {
      expect(error).toBeInstanceOf(BaerlyError);
      expect((error as Error).message).toContain("/log/");
    }
  });

  // ── Task 3: snapshot byte/row accounting + two-way ceiling. ─────────

  test("writes snapshot_bytes and snapshot_rows (= base.size) on a successful fold", async () => {
    const s = new MemoryStorage();
    await bootstrap(s, KEY);
    const writer = new Writer({ storage: s, currentJsonKey: KEY });
    for (let i = 0; i < 30; i++) {
      await writer.commit({
        op: "I",
        collection: COLL,
        docId: `d${i}`,
        body: { _id: `d${i}`, n: i },
      });
    }
    const res = await compact({ storage: s, currentJsonKey: KEY }, {
      minEntriesToCompact: 10,
      maxEntriesPerRun: 30,
    } as InternalCompactOptions);
    expect(res.written).toBe(true);
    const after = await readCurrentJson(s, KEY);
    expect(after!.json.snapshot_rows).toBe(30); // 30 distinct docs
    // snapshot_bytes is the byteLength of the encoded snapshot body.
    const body = await s.get(res.newSnapshotKey!);
    expect(after!.json.snapshot_bytes).toBe(body!.body.byteLength);
    expect(after!.json.snapshot_bytes).toBeGreaterThan(0);
  });

  test("tail_bytes decrements to exactly 0 when the whole tail folds in one slice", async () => {
    const s = new MemoryStorage();
    await bootstrap(s, KEY);
    const writer = new Writer({ storage: s, currentJsonKey: KEY });
    for (let i = 0; i < 25; i++) {
      await writer.commit({
        op: "I",
        collection: COLL,
        docId: `d${i}`,
        body: { _id: `d${i}`, n: i },
      });
    }
    const before = await readCurrentJson(s, KEY);
    expect(before!.json.tail_bytes).toBeGreaterThan(0);
    const res = await compact({ storage: s, currentJsonKey: KEY }, {
      minEntriesToCompact: 10,
      maxEntriesPerRun: 100, // ≥ N → whole tail in one slice
    } as InternalCompactOptions);
    expect(res.written).toBe(true);
    expect(res.logSeqStartAfter).toBe(25);
    const after = await readCurrentJson(s, KEY);
    expect(after!.json.tail_bytes).toBe(0);
  });

  test("tail_bytes decrements by exactly the folded slice's bytes (partial slice)", async () => {
    const s = new MemoryStorage();
    await bootstrap(s, KEY);
    const writer = new Writer({ storage: s, currentJsonKey: KEY });
    for (let i = 0; i < 30; i++) {
      await writer.commit({
        op: "I",
        collection: COLL,
        docId: `d${i}`,
        body: { _id: `d${i}`, n: i },
      });
    }
    const before = await readCurrentJson(s, KEY);
    // Sum the stored bytes of seq [0, 20) directly.
    let slice = 0;
    for (let seq = 0; seq < 20; seq++) {
      const got = await s.get(`app/t/tenant/x/manifests/c/log/${seq}.json`);
      slice += got!.body.byteLength;
    }
    const res = await compact({ storage: s, currentJsonKey: KEY }, {
      minEntriesToCompact: 10,
      maxEntriesPerRun: 20,
    } as InternalCompactOptions);
    expect(res.written).toBe(true);
    expect(res.logSeqStartAfter).toBe(20);
    const after = await readCurrentJson(s, KEY);
    expect(after!.json.tail_bytes).toBe(before!.json.tail_bytes - slice);
    expect(after!.json.tail_bytes).toBeGreaterThan(0); // 10 entries still in tail
  });

  // Critique C — the silent-drift guard. Write N entries of ARBITRARY
  // shape through the real Writer (which accumulates tail_bytes), then
  // fold the WHOLE tail in one slice and assert tail_bytes === 0 to the
  // BYTE. This bites only if writer-add and compactor-subtract count
  // identical bytes — the guardrail against framing drift.
  // Arbitrary DocumentValue-shaped payloads (no top-level `null`, which
  // is not a valid DocumentValue). Variety of byte content is what
  // exercises the framing-drift guard.
  const docValue = fc.oneof(
    fc.string(),
    fc.integer(),
    fc.double({ noNaN: true, noDefaultInfinity: true }),
    fc.boolean(),
    fc.array(fc.string(), { maxLength: 6 }),
    fc.dictionary(fc.string({ minLength: 1, maxLength: 6 }), fc.string(), { maxKeys: 6 }),
  );
  fcTest.prop({
    docs: fc.array(
      fc.record({
        // Constrain the id alphabet to characters that pass
        // `assertDocId`/`assertPathSegment` (now enforced inside
        // `Writer.commit`): no `/`, control chars, `.`/`..`, leading
        // `_`, or overlong segments. This test exercises tail_bytes
        // round-trip accounting, not `_id` validation — the prior
        // unconstrained `fc.string` generated traversal-shaped ids that
        // the guard now correctly rejects.
        id: fc.string({
          unit: fc.constantFrom(
            ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-",
          ),
          minLength: 1,
          maxLength: 12,
        }),
        payload: docValue,
      }),
      { minLength: 1, maxLength: 40 },
    ),
  })("add-then-fold round-trip: tail_bytes reaches exactly 0", async ({ docs }) => {
    const s = new MemoryStorage();
    const key = "app/t/tenant/x/manifests/rt/current.json";
    const coll = "rt";
    await createCurrentJson(
      s,
      key,
      logStateCurrentJson({ writer_fence: { epoch: 0, owner: "rt-test", claimed_at: "" } }),
    );
    const writer = new Writer({ storage: s, currentJsonKey: key });
    for (let i = 0; i < docs.length; i++) {
      const d = docs[i]!;
      // Unique doc id per commit so every entry is a distinct log object.
      await writer.commit({
        op: "I",
        collection: coll,
        docId: `${i}-${d.id}`,
        body: { _id: `${i}-${d.id}`, v: d.payload },
      });
    }
    const before = await readCurrentJson(s, key);
    expect(before!.json.tail_bytes).toBeGreaterThan(0);
    const res = await compact({ storage: s, currentJsonKey: key }, {
      minEntriesToCompact: 1,
      maxEntriesPerRun: docs.length + 10, // ≥ N → whole tail in one slice
    } as InternalCompactOptions);
    expect(res.written).toBe(true);
    expect(res.logSeqStartAfter).toBe(docs.length);
    const after = await readCurrentJson(s, key);
    expect(after!.json.tail_bytes).toBe(0); // EXACT, not ≈0
  });

  test("ceiling is on the SNAPSHOT not snapshot+tail: small snapshot + huge tail still folds", async () => {
    const s = new MemoryStorage();
    await bootstrap(s, KEY);
    const writer = new Writer({ storage: s, currentJsonKey: KEY });
    // Many entries, but the snapshot built from a maxEntriesPerRun slice
    // stays tiny. A generous ceilingBytes that the small snapshot fits
    // under must NOT defer just because the live tail is large.
    for (let i = 0; i < 60; i++) {
      await writer.commit({
        op: "I",
        collection: COLL,
        docId: `d${i}`,
        body: { _id: `d${i}` },
      });
    }
    const res = await compact({ storage: s, currentJsonKey: KEY }, {
      minEntriesToCompact: 10,
      maxEntriesPerRun: 10, // fold only a small slice → small snapshot
      ceilingBytes: 1_000_000,
      ceilingEntries: 1_000_000,
    } as InternalCompactOptions);
    expect(res.written).toBe(true);
    expect(res.logSeqStartAfter).toBe(10);
  });

  test("defers when the rebuilt snapshot bytes exceed ceilingBytes (current.json unchanged)", async () => {
    const s = new MemoryStorage();
    await bootstrap(s, KEY);
    const writer = new Writer({ storage: s, currentJsonKey: KEY });
    for (let i = 0; i < 20; i++) {
      await writer.commit({
        op: "I",
        collection: COLL,
        docId: `d${i}`,
        body: { _id: `d${i}`, n: i },
      });
    }
    const beforeRaw = await s.get(KEY);
    const res = await compact({ storage: s, currentJsonKey: KEY }, {
      minEntriesToCompact: 5,
      maxEntriesPerRun: 20,
      ceilingBytes: 1, // any non-empty snapshot trips this
    } as InternalCompactOptions);
    expect(res).toMatchObject({ written: false, deferred: true });
    expect(res.skippedReason).toBe("deferred");
    expect(res.logSeqStartAfter).toBe(res.logSeqStartBefore);
    // current.json byte-unchanged (no CAS, no PUT).
    const afterRaw = await s.get(KEY);
    expect(afterRaw!.body).toEqual(beforeRaw!.body);
  });

  test("defers on the tiny-doc case when snapshot rows exceed ceilingEntries", async () => {
    const s = new MemoryStorage();
    await bootstrap(s, KEY);
    const writer = new Writer({ storage: s, currentJsonKey: KEY });
    for (let i = 0; i < 20; i++) {
      await writer.commit({
        op: "I",
        collection: COLL,
        docId: `d${i}`,
        body: { _id: `d${i}` }, // tiny docs — bytes are small, rows are many
      });
    }
    const beforeRaw = await s.get(KEY);
    const res = await compact({ storage: s, currentJsonKey: KEY }, {
      minEntriesToCompact: 5,
      maxEntriesPerRun: 20,
      ceilingBytes: 1_000_000, // bytes fit
      ceilingEntries: 5, // 20 rows > 5 → defer on the rows axis
    } as InternalCompactOptions);
    expect(res).toMatchObject({ written: false, deferred: true });
    const afterRaw = await s.get(KEY);
    expect(afterRaw!.body).toEqual(beforeRaw!.body);
  });

  test("emits db.compaction.deferred_total with the tripped dimension on a rebuild defer", async () => {
    const s = new MemoryStorage();
    await bootstrap(s, KEY);
    const writer = new Writer({ storage: s, currentJsonKey: KEY });
    for (let i = 0; i < 20; i++) {
      await writer.commit({ op: "I", collection: COLL, docId: `d${i}`, body: { _id: `d${i}` } });
    }
    const ctx = createObservabilityContext();
    await runWithContext(ctx, async () => {
      await compact({ storage: s, currentJsonKey: KEY }, {
        minEntriesToCompact: 5,
        maxEntriesPerRun: 20,
        ceilingBytes: 1,
      } as InternalCompactOptions);
    });
    const snap = ctx.recorder.snapshot();
    const deferred = snap.counters.filter((c) => c.name === "db.compaction.deferred_total");
    expect(deferred).toEqual([
      {
        name: "db.compaction.deferred_total",
        value: 1,
        labels: { collection: COLL, dimension: "bytes" },
      },
    ]);
  });

  test("both ceilings undefined rebuild an arbitrarily large snapshot (unbounded reconcile)", async () => {
    const s = new MemoryStorage();
    await bootstrap(s, KEY);
    const writer = new Writer({ storage: s, currentJsonKey: KEY });
    for (let i = 0; i < 200; i++) {
      await writer.commit({
        op: "I",
        collection: COLL,
        docId: `d${i}`,
        body: { _id: `d${i}`, n: i, blob: "x".repeat(64) },
      });
    }
    // No ceilingBytes / ceilingEntries → no defer regardless of size.
    const res = await compact({ storage: s, currentJsonKey: KEY }, {
      minEntriesToCompact: 10,
      maxEntriesPerRun: 1000,
    } as InternalCompactOptions);
    expect(res.written).toBe(true);
    expect(res.logSeqStartAfter).toBe(200);
    const map = await loadSnapshotAsMap(s, res.newSnapshotKey!, COLL);
    expect(map.size).toBe(200);
  });

  test("maxEntriesPerRun slices a large tail (advances log_seq_start by only the slice)", async () => {
    const s = new MemoryStorage();
    await bootstrap(s, KEY);
    const writer = new Writer({ storage: s, currentJsonKey: KEY });
    for (let i = 0; i < 100; i++) {
      await writer.commit({ op: "I", collection: COLL, docId: `d${i}`, body: { _id: `d${i}` } });
    }
    const res = await compact({ storage: s, currentJsonKey: KEY }, {
      minEntriesToCompact: 10,
      maxEntriesPerRun: 30,
    } as InternalCompactOptions);
    expect(res.written).toBe(true);
    expect(res.logSeqStartAfter).toBe(30);
    expect(res.entriesFolded).toBe(30);
  });

  test("cas-lost: snapshot pointer unchanged, bumps cas_lost_total, orphan reclaimable by runGc", async () => {
    const inner = new MemoryStorage();
    await bootstrap(inner, KEY);
    const writer = new Writer({ storage: inner, currentJsonKey: KEY });
    for (let i = 0; i < 30; i++) {
      await writer.commit({ op: "I", collection: COLL, docId: `d${i}`, body: { _id: `d${i}` } });
    }
    const before = await readCurrentJson(inner, KEY);
    expect(before!.json.snapshot).toBeNull();
    // Fail the compactor's current.json CAS PUT exactly once.
    let failedOnce = false;
    const failingPut: Storage = {
      get: inner.get.bind(inner),
      delete: inner.delete.bind(inner),
      list: inner.list.bind(inner),
      async put(k: string, body: Uint8Array, opts?: StoragePutOptions): Promise<StoragePutResult> {
        if (!failedOnce && k === KEY && opts?.ifMatch !== undefined) {
          failedOnce = true;
          throw new BaerlyError("Conflict", "simulated CAS loss");
        }
        return inner.put(k, body, opts);
      },
    };
    const ctx = createObservabilityContext();
    let res!: Awaited<ReturnType<typeof compact>>;
    await runWithContext(ctx, async () => {
      res = await compact({ storage: failingPut, currentJsonKey: KEY }, {
        minEntriesToCompact: 10,
        maxEntriesPerRun: 30,
      } as InternalCompactOptions);
    });
    expect(res.written).toBe(false);
    expect(res.skippedReason).toBe("cas-lost");
    // current.json snapshot pointer is unchanged.
    const after = await readCurrentJson(inner, KEY);
    expect(after!.json.snapshot).toBeNull();
    // The metric was emitted by the COMPACTOR (not the runner).
    const snap = ctx.recorder.snapshot();
    expect(snap.counters.filter((c) => c.name === "db.compaction.cas_lost_total")).toEqual([
      { name: "db.compaction.cas_lost_total", value: 1, labels: { collection: COLL } },
    ]);
    // The orphan snapshot it wrote is reclaimable by runGc. Two-phase:
    // first pass marks it into gc/pending.json; with graceMillis:0 the
    // second pass sweeps it.
    expect(res.newSnapshotKey).toBeDefined();
    const orphan = await inner.get(res.newSnapshotKey!);
    expect(orphan).not.toBeNull();
    await runGc({ storage: inner, currentJsonKey: KEY }, {
      graceMillis: 0,
    } as Parameters<typeof runGc>[1]);
    await runGc({ storage: inner, currentJsonKey: KEY }, {
      graceMillis: 0,
    } as Parameters<typeof runGc>[1]);
    const swept = await inner.get(res.newSnapshotKey!);
    expect(swept).toBeNull();
  });
});
