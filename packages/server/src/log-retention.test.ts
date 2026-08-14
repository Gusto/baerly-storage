import {
  type CurrentJson,
  createCurrentJson,
  LOG_RETENTION_SEQ_WINDOW,
  logObjectKey,
  MemoryStorage,
  readCurrentJson,
} from "@baerly/protocol";
import { describe, expect, test } from "vitest";
import { logStateCurrentJson, seedLogEntry } from "../../../tests/fixtures/log-state.ts";
import { Db } from "./db.ts";
import { computeRetirableRange, retireLogRange } from "./log-retention.ts";

const cur = (logSeqStart: number, logDeleteFloor?: number): CurrentJson =>
  logStateCurrentJson({
    tail_hint: logSeqStart + 1000,
    log_seq_start: logSeqStart,
    ...(logDeleteFloor !== undefined && { log_delete_floor: logDeleteFloor }),
  });

describe("computeRetirableRange", () => {
  test("is empty when the floor has not cleared the window", () => {
    expect(computeRetirableRange(cur(100), { window: 500, maxDeletes: 20 })).toEqual({
      start: 0,
      end: 0,
    });
  });

  test("retires from the delete floor up to the per-pass budget", () => {
    expect(computeRetirableRange(cur(1000, 400), { window: 500, maxDeletes: 20 })).toEqual({
      start: 400,
      end: 420,
    });
  });

  test("clamps the end to the window boundary", () => {
    expect(computeRetirableRange(cur(1000, 495), { window: 500, maxDeletes: 20 })).toEqual({
      start: 495,
      end: 500,
    });
  });

  test("is empty when a raised window falls behind the delete floor", () => {
    expect(computeRetirableRange(cur(1000, 900), { window: 500, maxDeletes: 20 })).toEqual({
      start: 900,
      end: 900,
    });
  });

  test("clamps a malformed delete floor to the live floor", () => {
    expect(computeRetirableRange(cur(10, 900), { window: 0, maxDeletes: 20 })).toEqual({
      start: 10,
      end: 10,
    });
  });

  test("treats an absent delete floor as zero", () => {
    expect(computeRetirableRange(cur(1000), { window: 500, maxDeletes: 20 })).toEqual({
      start: 0,
      end: 20,
    });
  });

  test("never returns an end above log_seq_start", () => {
    const range = computeRetirableRange(cur(10), { window: 0, maxDeletes: 1000 });
    expect(range.end).toBeLessThanOrEqual(10);
  });

  test("uses the default window before the retention boundary", () => {
    expect(computeRetirableRange(cur(LOG_RETENTION_SEQ_WINDOW - 1))).toEqual({
      start: 0,
      end: 0,
    });
  });

  test("uses the default delete budget after the retention boundary", () => {
    expect(computeRetirableRange(cur(LOG_RETENTION_SEQ_WINDOW + 100))).toEqual({
      start: 0,
      end: 20,
    });
  });
});

const CURRENT_KEY = "app/a/tenant/t/manifests/c/current.json";
const PREFIX = "app/a/tenant/t/manifests/c";

/**
 * A fully-folded collection: `log_seq_start` at the tail, `seqCount` log
 * objects still on disk beneath it. That is the steady state retirement
 * exists to drain.
 */
const seedIdle = async (storage: MemoryStorage, seqCount: number): Promise<void> => {
  await createCurrentJson(
    storage,
    CURRENT_KEY,
    logStateCurrentJson({ log_seq_start: seqCount, tail_hint: seqCount }),
  );
  for (let seq = 0; seq < seqCount; seq++) {
    await seedLogEntry(storage, PREFIX, seq, {
      op: "I",
      doc_id: `seed-${String(seq)}`,
      after: { _id: `seed-${String(seq)}` },
    });
  }
};

describe("retireLogRange", () => {
  test("is a no-op, with no CAS at all, when the computed range is empty", async () => {
    const storage = new MemoryStorage();
    await seedIdle(storage, 3);
    const before = await readCurrentJson(storage, CURRENT_KEY);

    const result = await retireLogRange(storage, CURRENT_KEY, { window: 500, maxDeletes: 20 });

    expect(result).toEqual({ deleted: 0 });
    const after = await readCurrentJson(storage, CURRENT_KEY);
    expect(after!.etag).toBe(before!.etag);
  });

  test("retires the budgeted half-open range and advances log_delete_floor", async () => {
    const storage = new MemoryStorage();
    await seedIdle(storage, 50);

    const result = await retireLogRange(storage, CURRENT_KEY, { window: 5, maxDeletes: 20 });

    expect(result).toEqual({ deleted: 20 });
    const after = await readCurrentJson(storage, CURRENT_KEY);
    expect(after!.json.log_delete_floor).toBe(20);
    for (let seq = 0; seq < 20; seq++) {
      await expect(storage.get(logObjectKey(PREFIX, seq))).resolves.toBeNull();
    }
    for (let seq = 20; seq < 50; seq++) {
      await expect(storage.get(logObjectKey(PREFIX, seq))).resolves.not.toBeNull();
    }
  });

  test("a repeat pass resumes at the floor and never decreases it", async () => {
    const storage = new MemoryStorage();
    await seedIdle(storage, 50);

    await retireLogRange(storage, CURRENT_KEY, { window: 5, maxDeletes: 20 });
    const second = await retireLogRange(storage, CURRENT_KEY, { window: 5, maxDeletes: 20 });

    expect(second).toEqual({ deleted: 20 });
    const after = await readCurrentJson(storage, CURRENT_KEY);
    expect(after!.json.log_delete_floor).toBe(40);
    await expect(storage.get(logObjectKey(PREFIX, 39))).resolves.toBeNull();
    await expect(storage.get(logObjectKey(PREFIX, 40))).resolves.not.toBeNull();
  });

  test("counts DELETEs issued, not physical hits, when a target is already absent", async () => {
    const storage = new MemoryStorage();
    await seedIdle(storage, 50);
    await storage.delete(logObjectKey(PREFIX, 3)); // e.g. a crash-repeat pass

    const result = await retireLogRange(storage, CURRENT_KEY, { window: 5, maxDeletes: 20 });

    expect(result).toEqual({ deleted: 20 });
    const after = await readCurrentJson(storage, CURRENT_KEY);
    expect(after!.json.log_delete_floor).toBe(20);
  });

  test("never advances the floor above log_seq_start, even with an oversized budget", async () => {
    const storage = new MemoryStorage();
    await seedIdle(storage, 10);

    const result = await retireLogRange(storage, CURRENT_KEY, { window: 0, maxDeletes: 1000 });

    expect(result).toEqual({ deleted: 10 });
    const after = await readCurrentJson(storage, CURRENT_KEY);
    expect(after!.json.log_delete_floor).toBe(10);
    expect(after!.json.log_delete_floor).toBe(after!.json.log_seq_start);
  });

  test("a seq a real pass certified deleted is rejected by getLogEntry with the certified-delete message", async () => {
    // Pin 5's message distinction is already pinned against a SYNTHETIC floor
    // in db.test.ts. This adds the one thing that does not: that a REAL
    // retireLogRange call produces a floor state the reader seam rejects, and
    // rejects with the "gone", not the "folded", diagnostic (db.ts:391-431
    // checks the delete floor first).
    const storage = new MemoryStorage();
    await seedIdle(storage, 50);
    await retireLogRange(storage, CURRENT_KEY, { window: 5, maxDeletes: 20 });

    const current = await readCurrentJson(storage, CURRENT_KEY);
    const db = Db.create({ storage, app: "a", tenant: "t" });
    await expect(db.getLogEntry("c", 5, current!.json)).rejects.toMatchObject({
      code: "Internal",
      message: expect.stringContaining("certified delete floor"),
    });
  });
});
