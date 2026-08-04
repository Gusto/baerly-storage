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
  encodeJsonBytes,
  LOG_KEY_PREFIX,
  LOG_FORWARD_PROBE_CAP,
  readCurrentJson,
  type Storage,
  type StoragePutOptions,
  type StoragePutResult,
} from "@baerly/protocol";
import { describe, expect, test } from "vitest";
import { logStateCurrentJson, seedLogEntries } from "../../../tests/fixtures/log-state.ts";
import { compact, type InternalCompactOptions } from "./compactor.ts";
import { loadSnapshotAsMap, snapshotKey } from "./snapshot.ts";
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

const logObjectKeyPattern = new RegExp(String.raw`/${LOG_KEY_PREFIX}/(\d+)\.json$`);

const recordingStorage = (inner: MemoryStorage): { storage: Storage; logReadSeqs: number[] } => {
  const logReadSeqs: number[] = [];
  const storage: Storage = {
    get(key, opts) {
      const match = logObjectKeyPattern.exec(key);
      if (match !== null) {
        logReadSeqs.push(Number.parseInt(match[1]!, 10));
      }
      return inner.get(key, opts);
    },
    put: (key, body, opts) => inner.put(key, body, opts),
    delete: (key, opts) => inner.delete(key, opts),
    list: (prefix, opts) => inner.list(prefix, opts),
  };
  return { storage, logReadSeqs };
};

describe("compact", () => {
  const KEY = "app/t/tenant/x/manifests/c/current.json";
  const COLL = "c";

  test("a fold preserves current.json's generation", async () => {
    // `/v1/since` rejects a resume whose cursor generation no longer
    // matches the manifest, so a fold that DROPPED the field would
    // silently invalidate every live long-poll cursor on the next poll
    // — and, because absent decodes to the NO_GENERATION sentinel,
    // would do it without any read path erroring. The compactor gets
    // this right by spreading `...current` into its CAS; this pins that
    // it keeps doing so.
    const s = new MemoryStorage();
    await createCurrentJson(s, KEY, logStateCurrentJson({ generation: "0123456789ab" }));
    const writer = new Writer({ storage: s, currentJsonKey: KEY });
    for (let i = 0; i < 12; i++) {
      await writer.commit({
        op: "I",
        collection: COLL,
        docId: `d${i}`,
        body: { _id: `d${i}`, n: i },
      });
    }

    const res = await compact({ storage: s, currentJsonKey: KEY }, { minEntriesToCompact: 1 });
    expect(res.written).toBe(true);
    expect(res.entriesFolded).toBeGreaterThan(0);

    const after = await readCurrentJson(s, KEY);
    expect(after!.json.log_seq_start).toBeGreaterThan(0);
    expect(after!.json.generation).toBe("0123456789ab");
  });

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

  // The seq-arithmetic options ride an unvalidated seam
  // (`InternalCompactOptions`), reached by JS callers, in-repo casts,
  // and the `@baerly/server/_internal/testing` subpath. NaN is
  // the dangerous one and the reason this check exists rather than a
  // fold-floor assertion: NaN is false under every `<`/`>` guard in
  // `compact()`, so it would reach the fold, write a snapshot at a
  // `…-00000000000NaN-…` key, and CAS `log_seq_start: null` — bricking
  // the collection against every read path, `restore --force` included.
  // A negative value is the benign case (it would merely lower the floor).
  describe.each([
    ["maxEntriesPerRun", "negative", { maxEntriesPerRun: -1 }, "non-negative"],
    ["maxEntriesPerRun", "NaN", { maxEntriesPerRun: Number.NaN }, "non-negative"],
    [
      "maxEntriesPerRun",
      "Infinity",
      { maxEntriesPerRun: Number.POSITIVE_INFINITY },
      "non-negative",
    ],
    ["maxEntriesPerRun", "fractional", { maxEntriesPerRun: 1.5 }, "non-negative"],
    ["knownTail", "NaN", { knownTail: Number.NaN }, "non-negative"],
    ["knownTail", "negative", { knownTail: -1 }, "non-negative"],
    ["maxTailProbeGets", "zero", { maxTailProbeGets: 0 }, "positive"],
    ["maxTailProbeGets", "negative", { maxTailProbeGets: -1 }, "positive"],
    ["maxTailProbeGets", "NaN", { maxTailProbeGets: Number.NaN }, "positive"],
    ["maxTailProbeGets", "Infinity", { maxTailProbeGets: Number.POSITIVE_INFINITY }, "positive"],
    ["maxTailProbeGets", "fractional", { maxTailProbeGets: 1.5 }, "positive"],
  ])("rejects %s = %s at the seam", (option, _shape, overrides, integerContract) => {
    test("fails closed before invoking storage", async () => {
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
      const before = await readCurrentJson(s, KEY);
      const failStorageOperation = (operation: keyof Storage): never => {
        throw new Error(`compact must validate before storage.${operation}()`);
      };
      const storageThatFailsAllOperations: Storage = {
        get: () => failStorageOperation("get"),
        put: () => failStorageOperation("put"),
        delete: () => failStorageOperation("delete"),
        list: () => failStorageOperation("list"),
      };

      await expect(
        compact({ storage: storageThatFailsAllOperations, currentJsonKey: KEY }, {
          minEntriesToCompact: 1,
          ...overrides,
        } as InternalCompactOptions),
      ).rejects.toMatchObject({
        code: "InvalidConfig",
        message: expect.stringContaining(`${option} must be a ${integerContract} integer`),
      });

      // Nothing moved: the floor is intact, no snapshot pointer, and no
      // orphan snapshot object was left on the bucket.
      const after = await readCurrentJson(s, KEY);
      expect(after?.json.log_seq_start).toBe(before?.json.log_seq_start);
      expect(after?.json.snapshot).toBeNull();
      const snapshots: string[] = [];
      for await (const entry of s.list(`${KEY.slice(0, KEY.lastIndexOf("/"))}/snapshot/`)) {
        snapshots.push(entry.key);
      }
      expect(snapshots).toEqual([]);
    });
  });

  test("snapshotKey rejects a non-finite seq rather than padding it into the key", () => {
    // Defense in depth one layer under the seam check above: every
    // comparison in the range guard is false against NaN, so without an
    // explicit integer test `pad(NaN)` yields a `000000000NaN` filename.
    const hash = "a".repeat(64);
    expect(() => snapshotKey("p/c", 0, Number.NaN, hash)).toThrowError(
      expect.objectContaining({ code: "InvalidConfig" }),
    );
    expect(() => snapshotKey("p/c", Number.NaN, 10, hash)).toThrowError(
      expect.objectContaining({ code: "InvalidConfig" }),
    );
    expect(() => snapshotKey("p/c", 0, Number.POSITIVE_INFINITY, hash)).toThrowError(
      expect.objectContaining({ code: "InvalidConfig" }),
    );
    // The valid case still builds the zero-padded key.
    expect(snapshotKey("p/c", 0, 40, hash)).toBe(
      `p/c/snapshot/L9/${"0".repeat(12)}-${"0".repeat(10)}40-${hash}.json`,
    );
  });

  test("a validated fold still advances the floor from a healthy default", async () => {
    // Guards the guard: the seam check must not reject the ordinary
    // no-overrides call, where `maxEntriesPerRun` defaults to
    // MAX_SAFE_INTEGER and `knownTail` is absent.
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
    const res = await compact({ storage: s, currentJsonKey: KEY }, { minEntriesToCompact: 1 });
    expect(res.written).toBe(true);
    expect(res.logSeqStartAfter).toBeGreaterThan(res.logSeqStartBefore);
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
    // Live tail after fold = 50 (tail_hint) - 40 (foldEnd) = 10.
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
    await createCurrentJson(s, KEY, logStateCurrentJson({ tail_hint: 10 }));
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

  test("stamps mean_entry_bytes = round(foldedSliceBytes / entriesFolded) on a fold", async () => {
    const s = new MemoryStorage();
    await bootstrap(s, KEY);
    const writer = new Writer({ storage: s, currentJsonKey: KEY });
    // Vary the doc-id / payload length so the per-entry byte sizes differ
    // and B / K is non-integer → exercises Math.round.
    const K = 21;
    for (let i = 0; i < K; i++) {
      await writer.commit({
        op: "I",
        collection: COLL,
        docId: `d${i}`,
        body: { _id: `d${i}`, blob: "x".repeat(i) },
      });
    }
    // Sum the stored bytes of the whole folded slice [0, K) directly.
    let B = 0;
    for (let seq = 0; seq < K; seq++) {
      const got = await s.get(`app/t/tenant/x/manifests/c/log/${seq}.json`);
      B += got!.body.byteLength;
    }
    const res = await compact({ storage: s, currentJsonKey: KEY }, {
      minEntriesToCompact: 10,
      maxEntriesPerRun: 100, // ≥ K → whole tail in one slice
    } as InternalCompactOptions);
    expect(res.written).toBe(true);
    expect(res.entriesFolded).toBe(K);
    const after = await readCurrentJson(s, KEY);
    expect(after!.json.mean_entry_bytes).toBe(Math.round(B / K));
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
    expect(res.entriesFolded).toBe(0);
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

  // ── Phase 3 Task 3.2: forward-probe the true tail as the fold ceiling
  // and stamp tail_hint = max(stored, discovered). The stored tail_hint
  // is a non-authoritative LOWER BOUND; the true committed tail may sit
  // above it. The compactor must discover it via a forward-probe and stamp
  // the folded tail.
  test("forward-probes a tail above a stale-low tail_hint, folds to the true tail, and stamps tail_hint", async () => {
    const s = new MemoryStorage();
    const M = 30;
    const L = 12; // deliberately stale-low stored hint, below the true tail M
    const logPrefix = KEY.slice(0, KEY.lastIndexOf("/"));
    // Seed a DENSE log [0, M) directly.
    await seedLogEntries(s, logPrefix, 0, M, (seq) => ({
      doc_id: `d${seq}`,
      after: { _id: `d${seq}`, n: seq },
    }));
    // Hand-write current.json with tail_hint = L < M.
    await createCurrentJson(s, KEY, logStateCurrentJson({ tail_hint: L }));
    const res = await compact({ storage: s, currentJsonKey: KEY }, {
      minEntriesToCompact: 5,
      maxEntriesPerRun: 100, // one pass can reach the true tail M
    } as InternalCompactOptions);
    expect(res.written).toBe(true);
    // Folded up to the TRUE tail M, not the stale stored hint L.
    expect(res.logSeqStartAfter).toBe(M);
    expect(res.entriesFolded).toBe(M);
    const map = await loadSnapshotAsMap(s, res.newSnapshotKey!, COLL);
    expect(map.size).toBe(M);
    // tail_hint stamped to the discovered tail (monotone max).
    const after = await readCurrentJson(s, KEY);
    expect(after!.json.tail_hint).toBe(M);
  });

  test("a bounded fold reads its contiguous slice once and publishes its fold end", async () => {
    const inner = new MemoryStorage();
    const recording = recordingStorage(inner);
    const tail = 8;
    const foldEnd = 3;
    const logPrefix = KEY.slice(0, KEY.lastIndexOf("/"));
    await seedLogEntries(inner, logPrefix, 0, tail, (seq) => ({
      doc_id: `d${seq}`,
      after: { _id: `d${seq}`, n: seq },
    }));
    await createCurrentJson(inner, KEY, logStateCurrentJson({ tail_hint: tail }));

    const res = await compact({ storage: recording.storage, currentJsonKey: KEY }, {
      minEntriesToCompact: 1,
      maxEntriesPerRun: foldEnd,
      knownTail: tail,
    } as InternalCompactOptions);

    expect(res.written).toBe(true);
    expect(res.logSeqStartBefore).toBe(0);
    expect(res.logSeqStartAfter).toBe(foldEnd);
    expect(recording.logReadSeqs).toEqual([8, 0, 1, 2]);
    const after = await readCurrentJson(inner, KEY);
    expect(after!.json.log_seq_start).toBe(foldEnd);
  });

  test("an unbounded fold reads through its discovered tail and publishes it", async () => {
    const inner = new MemoryStorage();
    const recording = recordingStorage(inner);
    const tail = 8;
    const logPrefix = KEY.slice(0, KEY.lastIndexOf("/"));
    await seedLogEntries(inner, logPrefix, 0, tail, (seq) => ({
      doc_id: `d${seq}`,
      after: { _id: `d${seq}`, n: seq },
    }));
    await bootstrap(inner, KEY);

    const res = await compact(
      { storage: recording.storage, currentJsonKey: KEY },
      {
        minEntriesToCompact: 1,
      },
    );

    expect(res.written).toBe(true);
    expect(res.logSeqStartAfter).toBe(tail);
    expect(recording.logReadSeqs).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 0, 1, 2, 3, 4, 5, 6, 7]);
    const after = await readCurrentJson(inner, KEY);
    expect(after!.json.log_seq_start).toBe(tail);
  });

  test("a missing sequence rejects without publishing a new floor", async () => {
    const inner = new MemoryStorage();
    const recording = recordingStorage(inner);
    const tail = 7;
    const logPrefix = KEY.slice(0, KEY.lastIndexOf("/"));
    await seedLogEntries(inner, logPrefix, 0, 3);
    await seedLogEntries(inner, logPrefix, 4, tail);
    await createCurrentJson(inner, KEY, logStateCurrentJson({ tail_hint: tail }));
    const before = await readCurrentJson(inner, KEY);

    await expect(
      compact({ storage: recording.storage, currentJsonKey: KEY }, {
        minEntriesToCompact: 1,
        knownTail: tail,
      } as InternalCompactOptions),
    ).rejects.toMatchObject({ code: "Internal" });

    expect(recording.logReadSeqs).toEqual([7, 0, 1, 2, 3, 4, 5, 6]);
    const after = await readCurrentJson(inner, KEY);
    expect(after).toEqual(before);
  });

  test("checkpoints an incomplete bounded tail probe without writing a snapshot", async () => {
    const s = new MemoryStorage();
    const collectionPrefix = KEY.slice(0, KEY.lastIndexOf("/"));
    await bootstrap(s, KEY);
    await seedLogEntries(s, collectionPrefix, 0, 100);

    const res = await compact({ storage: s, currentJsonKey: KEY }, {
      minEntriesToCompact: 50,
      maxEntriesPerRun: 20,
      maxTailProbeGets: 25,
    } as InternalCompactOptions);

    expect(res).toMatchObject({ written: false, skippedReason: "probe-budget-checkpointed" });
    expect((await readCurrentJson(s, KEY))!.json).toMatchObject({
      log_seq_start: 0,
      tail_hint: 25,
      snapshot: null,
    });
  });

  test("the default tail probe rejects a full protocol-cap run without publishing", async () => {
    // Replacing `probeTailFrom` with the chunk probe on the default path
    // would accept its `at-least` result and fold a non-exact tail. The
    // default safety contract must instead surface the runaway as Internal.
    const inner = new MemoryStorage();
    const collectionPrefix = KEY.slice(0, KEY.lastIndexOf("/"));
    await bootstrap(inner, KEY);
    const entry = encodeJsonBytes({
      seq: 0,
      op: "I",
      collection: COLL,
      doc_id: "d0",
      after: { _id: "d0" },
    });
    let logGets = 0;
    const putKeys: string[] = [];
    const alwaysOccupied: Storage = {
      async get(key, opts) {
        if (key.startsWith(`${collectionPrefix}/${LOG_KEY_PREFIX}/`)) {
          logGets++;
          return { body: entry, etag: "always-occupied" };
        }
        return inner.get(key, opts);
      },
      async put(key, body, opts) {
        putKeys.push(key);
        return inner.put(key, body, opts);
      },
      delete: (key, opts) => inner.delete(key, opts),
      list: (prefix, opts) => inner.list(prefix, opts),
    };

    await expect(
      compact({ storage: alwaysOccupied, currentJsonKey: KEY }, { minEntriesToCompact: 1 }),
    ).rejects.toMatchObject({ code: "Internal" });

    expect(logGets).toBe(LOG_FORWARD_PROBE_CAP);
    expect(putKeys).toEqual([]);
  });

  test("folds a certified probe lower bound without emitting an exact lag gauge", async () => {
    const s = new MemoryStorage();
    const collectionPrefix = KEY.slice(0, KEY.lastIndexOf("/"));
    await bootstrap(s, KEY);
    await seedLogEntries(s, collectionPrefix, 0, 100);
    const ctx = createObservabilityContext();
    let res!: Awaited<ReturnType<typeof compact>>;

    await runWithContext(ctx, async () => {
      res = await compact({ storage: s, currentJsonKey: KEY }, {
        minEntriesToCompact: 20,
        maxEntriesPerRun: 20,
        maxTailProbeGets: 25,
      } as InternalCompactOptions);
    });

    expect(res.entriesFolded).toBe(20);
    expect((await readCurrentJson(s, KEY))!.json).toMatchObject({
      log_seq_start: 20,
      tail_hint: 25,
    });
    const metrics = ctx.recorder.snapshot();
    expect(metrics.histograms).toContainEqual({
      name: "db.compact.entries_folded",
      value: 20,
      labels: { collection: COLL },
    });
    expect(
      metrics.gauges.find((gauge) => gauge.name === "db.manifest.lag_window_depth"),
    ).toBeUndefined();
  });

  test("returns cas-lost when an incomplete-probe checkpoint loses its ETag", async () => {
    const inner = new MemoryStorage();
    const collectionPrefix = KEY.slice(0, KEY.lastIndexOf("/"));
    await bootstrap(inner, KEY);
    await seedLogEntries(inner, collectionPrefix, 0, 100);
    let failedOnce = false;
    const failingPut: Storage = {
      get: inner.get.bind(inner),
      delete: inner.delete.bind(inner),
      list: inner.list.bind(inner),
      async put(
        key: string,
        body: Uint8Array,
        opts?: StoragePutOptions,
      ): Promise<StoragePutResult> {
        if (!failedOnce && key === KEY && opts?.ifMatch !== undefined) {
          failedOnce = true;
          throw new BaerlyError("Conflict", "simulated checkpoint CAS loss");
        }
        return inner.put(key, body, opts);
      },
    };
    const ctx = createObservabilityContext();
    let res!: Awaited<ReturnType<typeof compact>>;

    await runWithContext(ctx, async () => {
      res = await compact({ storage: failingPut, currentJsonKey: KEY }, {
        minEntriesToCompact: 50,
        maxEntriesPerRun: 20,
        maxTailProbeGets: 25,
      } as InternalCompactOptions);
    });

    expect(res.skippedReason).toBe("cas-lost");
    expect((await readCurrentJson(inner, KEY))!.json.tail_hint).toBe(0);
    const snapshots: string[] = [];
    for await (const entry of inner.list(`${collectionPrefix}/snapshot/`)) {
      snapshots.push(entry.key);
    }
    expect(snapshots).toEqual([]);
    expect(
      ctx.recorder
        .snapshot()
        .counters.filter((counter) => counter.name === "db.compaction.cas_lost_total"),
    ).toEqual([{ name: "db.compaction.cas_lost_total", value: 1, labels: { collection: COLL } }]);
  });

  test("cas-lost: snapshot orphan stays pending until a later fold advances beyond it", async () => {
    const inner = new MemoryStorage();
    const recording = recordingStorage(inner);
    const foldEnd = 30;
    await bootstrap(inner, KEY);
    const writer = new Writer({ storage: inner, currentJsonKey: KEY });
    for (let i = 0; i < foldEnd; i++) {
      await writer.commit({ op: "I", collection: COLL, docId: `d${i}`, body: { _id: `d${i}` } });
    }
    const before = await readCurrentJson(inner, KEY);
    expect(before!.json.snapshot).toBeNull();
    // Fail the compactor's current.json CAS PUT exactly once.
    let failedOnce = false;
    const failingPut: Storage = {
      get: recording.storage.get,
      delete: recording.storage.delete,
      list: recording.storage.list,
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
        maxEntriesPerRun: foldEnd,
      } as InternalCompactOptions);
    });
    expect(res.written).toBe(false);
    expect(res.skippedReason).toBe("cas-lost");
    expect(res.logSeqStartAfter).toBe(res.logSeqStartBefore);
    expect(res.entriesFolded).toBe(foldEnd - res.logSeqStartBefore);
    expect(recording.logReadSeqs).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25,
      26, 27, 28, 29, 30, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
      21, 22, 23, 24, 25, 26, 27, 28, 29,
    ]);
    // The entire current.json head is unchanged after the lost CAS.
    const after = await readCurrentJson(inner, KEY);
    expect(after).toEqual(before);
    // The metric was emitted by the COMPACTOR (not the runner).
    const snap = ctx.recorder.snapshot();
    expect(snap.counters.filter((c) => c.name === "db.compaction.cas_lost_total")).toEqual([
      { name: "db.compaction.cas_lost_total", value: 1, labels: { collection: COLL } },
    ]);
    // The orphan snapshot covers [0, 30), but the lost CAS leaves the fresh
    // manifest floor at 0. GC must mark and retain it: a compactor could still
    // publish this exact object until the monotone floor advances beyond 30.
    expect(res.newSnapshotKey).toBeDefined();
    const orphan = await inner.get(res.newSnapshotKey!);
    expect(orphan).not.toBeNull();
    const retained = await runGc({ storage: inner, currentJsonKey: KEY }, {
      graceMillis: 0,
    } as Parameters<typeof runGc>[1]);
    expect(retained.marked.orphan_snapshot).toBe(1);
    expect(retained.swept).toBe(0);
    expect(retained.pendingDepth).toBe(1);
    await expect(inner.get(res.newSnapshotKey!)).resolves.not.toBeNull();

    // Commit one more entry, then perform a real successful fold through 31.
    // The fresh floor is now strictly beyond the CAS-lost snapshot's max_seq,
    // making that pending candidate safe to reclaim on the next GC pass.
    await writer.commit({
      op: "I",
      collection: COLL,
      docId: `d${foldEnd}`,
      body: { _id: `d${foldEnd}` },
    });
    const advanced = await compact({ storage: inner, currentJsonKey: KEY }, {
      minEntriesToCompact: 10,
      maxEntriesPerRun: foldEnd + 1,
    } as InternalCompactOptions);
    expect(advanced.written).toBe(true);
    expect(advanced.logSeqStartAfter).toBe(foldEnd + 1);
    expect(advanced.newSnapshotKey).not.toBe(res.newSnapshotKey);

    // Default grace keeps the newly marked stale logs pending, so this one
    // sweep is specifically the older, already-due snapshot candidate.
    const reclaimed = await runGc({ storage: inner, currentJsonKey: KEY });
    expect(reclaimed.swept).toBe(1);
    const swept = await inner.get(res.newSnapshotKey!);
    expect(swept).toBeNull();
    await expect(inner.get(advanced.newSnapshotKey!)).resolves.not.toBeNull();
  });
});
