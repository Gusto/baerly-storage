/**
 * Unit tests for `walkLogRange` / `readLogEntry`. Covers seq-order
 * preservation, the concurrency bound, error semantics on missing /
 * malformed entries, the empty range, and AbortSignal short-circuit.
 */

import {
  BaerlyError,
  MAX_PARALLEL_LOG_READS,
  MemoryStorage,
  type LogEntry,
  type Storage,
  type StorageGetOptions,
  type StorageGetResult,
  type StorageListEntry,
  type StoragePutOptions,
  type StoragePutResult,
} from "@baerly/protocol";
import { describe, expect, test } from "vitest";
import { readLogEntry, walkLogRange } from "./log-walk.ts";

const PREFIX = "app/t/tenant/x/manifests/c";

const makeEntry = (seq: number): LogEntry => ({
  lsn: `lsn-${seq}`,
  commit_ts: "2026-01-01T00:00:00.000Z",
  op: "I",
  collection: "c",
  doc_id: `d${seq}`,
  session: "ssn001",
  seq,
});

const seedRange = async (storage: Storage, from: number, toExclusive: number): Promise<void> => {
  const enc = new TextEncoder();
  for (let s = from; s < toExclusive; s++) {
    const body = enc.encode(JSON.stringify(makeEntry(s)));
    await storage.put(`${PREFIX}/log/${s}.json`, body);
  }
};

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
