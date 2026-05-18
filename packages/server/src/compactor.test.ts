/* eslint-disable no-underscore-dangle -- `_id` is the locked primary-key
   field on document shapes (see `@baerly/protocol/src/db.ts`'s `Table<T>`
   declaration); snapshot body docs carry it through. */

/**
 * Compactor — `compact()` happy paths and invariants under
 * `MemoryStorage`. The cross-adapter coverage (memory / local-fs /
 * node-minio / cloudflare-r2) is exercised by the `[compaction]`
 * variant inside `tests/fixtures/table-api-cascade.ts`.
 */

import {
  CURRENT_JSON_SCHEMA_VERSION,
  InMemoryMetricsRecorder,
  createCurrentJson,
  MemoryStorage,
  BaerlyError,
} from "@baerly/protocol";
import { describe, expect, it } from "vitest";
import { compact, type InternalCompactOptions, loadSnapshotAsMap } from "./compactor.ts";
import { ServerWriter } from "./server-writer.ts";

const bootstrap = async (storage: MemoryStorage, key: string): Promise<void> => {
  await createCurrentJson(storage, key, {
    schema_version: CURRENT_JSON_SCHEMA_VERSION,
    snapshot: null,
    next_seq: 0,
    log_seq_start: 0,
    writer_fence: { epoch: 0, owner: "compactor-test", claimed_at: "" },
  });
};

describe("compact", () => {
  const KEY = "app/t/tenant/x/manifests/c/current.json";
  const COLL = "c";

  it("returns current-json-missing when current.json doesn't exist", async () => {
    const s = new MemoryStorage();
    const res = await compact({ storage: s, currentJsonKey: KEY });
    expect(res.written).toBe(false);
    expect(res.skippedReason).toBe("current-json-missing");
    expect(res.previousSnapshotKey).toBeNull();
    expect(res.entriesFolded).toBe(0);
  });

  it("skips when below min threshold", async () => {
    const s = new MemoryStorage();
    await bootstrap(s, KEY);
    const writer = new ServerWriter({ storage: s, currentJsonKey: KEY });
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

  it("writes a snapshot and advances log_seq_start", async () => {
    const s = new MemoryStorage();
    await bootstrap(s, KEY);
    const writer = new ServerWriter({ storage: s, currentJsonKey: KEY });
    for (let i = 0; i < 50; i++) {
      await writer.commit({
        op: "I",
        collection: COLL,
        docId: `d${i}`,
        body: { _id: `d${i}`, n: i },
      });
    }
    const res = await compact(
      { storage: s, currentJsonKey: KEY },
      { minEntriesToCompact: 10, maxEntriesPerRun: 40 } as InternalCompactOptions,
    );
    expect(res.written).toBe(true);
    expect(res.entriesFolded).toBe(40);
    expect(res.logSeqStartBefore).toBe(0);
    expect(res.logSeqStartAfter).toBe(40);
    expect(res.previousSnapshotKey).toBeNull();
    expect(res.newSnapshotKey).toBeDefined();
    // L9/<12-digit min>-<12-digit max>-<64 hex>.json under tablePrefix.
    expect(res.newSnapshotKey).toMatch(/\/snapshot\/L9\/0{12}-0{10}40-[0-9a-f]{64}\.json$/);
  });

  it("is idempotent: re-running with no new writes is a no-op", async () => {
    const s = new MemoryStorage();
    await bootstrap(s, KEY);
    const writer = new ServerWriter({ storage: s, currentJsonKey: KEY });
    // 50 entries, fold them all in one shot so no live tail remains.
    for (let i = 0; i < 50; i++) {
      await writer.commit({
        op: "I",
        collection: COLL,
        docId: `d${i}`,
        body: { _id: `d${i}`, n: i },
      });
    }
    const a = await compact(
      { storage: s, currentJsonKey: KEY },
      { minEntriesToCompact: 10, maxEntriesPerRun: 100 } as InternalCompactOptions,
    );
    expect(a.written).toBe(true);
    expect(a.logSeqStartAfter).toBe(50);
    // With log_seq_start now at 50 and no new writes, the live-tail
    // length is 0 < minEntriesToCompact → skip.
    const b = await compact(
      { storage: s, currentJsonKey: KEY },
      { minEntriesToCompact: 10, maxEntriesPerRun: 100 } as InternalCompactOptions,
    );
    expect(b.written).toBe(false);
    expect(b.skippedReason).toBe("below-min-threshold");
    expect(b.previousSnapshotKey).toBe(a.newSnapshotKey);
  });

  it("subsequent run extends the snapshot when new writes have landed", async () => {
    const s = new MemoryStorage();
    await bootstrap(s, KEY);
    const writer = new ServerWriter({ storage: s, currentJsonKey: KEY });
    for (let i = 0; i < 40; i++) {
      await writer.commit({
        op: "I",
        collection: COLL,
        docId: `d${i}`,
        body: { _id: `d${i}`, n: i },
      });
    }
    const first = await compact(
      { storage: s, currentJsonKey: KEY },
      { minEntriesToCompact: 10, maxEntriesPerRun: 40 } as InternalCompactOptions,
    );
    expect(first.written).toBe(true);

    for (let i = 40; i < 80; i++) {
      await writer.commit({
        op: "I",
        collection: COLL,
        docId: `d${i}`,
        body: { _id: `d${i}`, n: i },
      });
    }
    const res = await compact(
      { storage: s, currentJsonKey: KEY },
      { minEntriesToCompact: 10, maxEntriesPerRun: 40 } as InternalCompactOptions,
    );
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

  it("snapshot body hash matches the filename hash", async () => {
    const s = new MemoryStorage();
    await bootstrap(s, KEY);
    const writer = new ServerWriter({ storage: s, currentJsonKey: KEY });
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

  it("rejects a snapshot whose body has been tampered with", async () => {
    const s = new MemoryStorage();
    await bootstrap(s, KEY);
    const writer = new ServerWriter({ storage: s, currentJsonKey: KEY });
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

  it("treats a snapshot pointer with no body as a protocol violation", async () => {
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

  it("delete tombstones drop docs from the snapshot fold", async () => {
    const s = new MemoryStorage();
    await bootstrap(s, KEY);
    const writer = new ServerWriter({ storage: s, currentJsonKey: KEY });
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

  it("rejects a snapshot body that names a different collection", async () => {
    const s = new MemoryStorage();
    await bootstrap(s, KEY);
    const writer = new ServerWriter({ storage: s, currentJsonKey: KEY });
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

  it("emits db.compact.entries_folded and db.manifest.lag_window_depth on success", async () => {
    const s = new MemoryStorage();
    await bootstrap(s, KEY);
    const writer = new ServerWriter({ storage: s, currentJsonKey: KEY });
    for (let i = 0; i < 50; i++) {
      await writer.commit({
        op: "I",
        collection: COLL,
        docId: `d${i}`,
        body: { _id: `d${i}`, n: i },
      });
    }
    const metrics = new InMemoryMetricsRecorder();
    const res = await compact(
      { storage: s, currentJsonKey: KEY },
      { minEntriesToCompact: 10, maxEntriesPerRun: 40, metrics } as InternalCompactOptions,
    );
    expect(res.written).toBe(true);
    // Folded 40 of the 50 available.
    expect(metrics.histogramValues("db.compact.entries_folded")).toEqual([40]);
    // Live tail after fold = 50 (next_seq) - 40 (foldEnd) = 10.
    expect(metrics.lastGauge("db.manifest.lag_window_depth")).toBe(10);
  });

  it("emits no metrics when run is skipped (below-min-threshold)", async () => {
    const s = new MemoryStorage();
    await bootstrap(s, KEY);
    const metrics = new InMemoryMetricsRecorder();
    const res = await compact(
      { storage: s, currentJsonKey: KEY },
      { minEntriesToCompact: 10, metrics },
    );
    expect(res.written).toBe(false);
    expect(metrics.histogramValues("db.compact.entries_folded")).toEqual([]);
    expect(metrics.lastGauge("db.manifest.lag_window_depth")).toBeUndefined();
  });

  it("surfaces a missing log entry inside the fold window as Internal", async () => {
    const s = new MemoryStorage();
    // Hand-craft a current.json claiming 10 log entries exist but
    // never plant the bodies. compact() walks [0, 10) and should
    // throw Internal on the first missing GET.
    await createCurrentJson(s, KEY, {
      schema_version: CURRENT_JSON_SCHEMA_VERSION,
      snapshot: null,
      next_seq: 10,
      log_seq_start: 0,
      writer_fence: { epoch: 0, owner: "test", claimed_at: "" },
    });
    await expect(
      compact({ storage: s, currentJsonKey: KEY }, { minEntriesToCompact: 5 }),
    ).rejects.toMatchObject({ code: "Internal" });
    // The error message names the missing key prefix.
    try {
      await compact({ storage: s, currentJsonKey: KEY }, { minEntriesToCompact: 5 });
    } catch (err) {
      expect(err).toBeInstanceOf(BaerlyError);
      expect((err as Error).message).toContain("/log/");
    }
  });
});
