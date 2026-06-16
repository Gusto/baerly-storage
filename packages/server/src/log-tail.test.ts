/**
 * Unit tests for `probeTailFrom` — the tolerant forward-probe that
 * discovers the true committed tail by GET-walking `log/<seq>` from a
 * hint and stopping at the first 404. Covers a dense run, a hint
 * already at the tail, a below-tail hint that stops at the first gap,
 * and the cap on a pathologically long run.
 */

import {
  BaerlyError,
  LOG_FORWARD_PROBE_CAP,
  logObjectKey,
  MemoryStorage,
  type Storage,
} from "@baerly/protocol";
import { describe, expect, test } from "vitest";
import { seedLogEntries } from "../../../tests/fixtures/log-state.ts";
import { findLogTail, probeTailFrom } from "./log-tail.ts";

const PREFIX = "app/t/tenant/x/manifests/c";

describe("probeTailFrom", () => {
  test("dense [5,9] from hint=5 walks to the true tail", async () => {
    const storage = new MemoryStorage();
    await seedLogEntries(storage, PREFIX, 5, 10); // seqs 5..9

    const { tail, entries } = await probeTailFrom(storage, PREFIX, 5);
    expect(tail).toBe(10);
    expect(entries.map((e) => e.seq)).toEqual([5, 6, 7, 8, 9]);
  });

  test("hint already at the tail returns empty", async () => {
    const storage = new MemoryStorage();
    // Nothing seeded at or above the hint.
    const { tail, entries } = await probeTailFrom(storage, PREFIX, 12);
    expect(tail).toBe(12);
    expect(entries).toEqual([]);
  });

  test("hint below several committed walks to the first gap and stops", async () => {
    const storage = new MemoryStorage();
    // Dense 3..7, then a hole at 8 (9 present but unreachable past the gap).
    await seedLogEntries(storage, PREFIX, 3, 8); // seqs 3..7
    await seedLogEntries(storage, PREFIX, 9, 10); // seq 9, after the hole

    const { tail, entries } = await probeTailFrom(storage, PREFIX, 3);
    expect(tail).toBe(8);
    expect(entries.map((e) => e.seq)).toEqual([3, 4, 5, 6, 7]);
  });

  test("cap respected: stops at hint+cap without walking past it", async () => {
    const storage = new MemoryStorage();
    // Dense run longer than the cap we pass.
    await seedLogEntries(storage, PREFIX, 0, 10); // seqs 0..9

    const cap = 4;
    const { tail, entries } = await probeTailFrom(storage, PREFIX, 0, { cap });
    expect(tail).toBe(0 + cap);
    expect(entries).toHaveLength(cap);
    expect(entries.map((e) => e.seq)).toEqual([0, 1, 2, 3]);
  });

  test("default cap is LOG_FORWARD_PROBE_CAP", () => {
    expect(LOG_FORWARD_PROBE_CAP).toBe(100_000);
  });

  test("a non-404 get error propagates — never silently read as the tail", async () => {
    // One real entry at the hint, then a get that THROWS a non-404. A
    // "treat any non-null-miss as tail" regression would resolve to a
    // truncated 1-entry result; the safety property is that it rejects.
    const backing = new MemoryStorage();
    await seedLogEntries(backing, PREFIX, 5, 6); // seq 5 present
    const throwAtSeq6 = logObjectKey(PREFIX, 6);
    // probeTailFrom only ever calls `get`; override just that, delegating
    // every other (unused) method to the backing store.
    const storage: Storage = {
      get: async (key, opts) => {
        if (key === throwAtSeq6) {
          throw new BaerlyError("NetworkError", "boom");
        }
        return backing.get(key, opts);
      },
      put: (key, body, opts) => backing.put(key, body, opts),
      delete: (key, opts) => backing.delete(key, opts),
      list: (prefix, opts) => backing.list(prefix, opts),
    };

    await expect(probeTailFrom(storage, PREFIX, 5)).rejects.toMatchObject({
      code: "NetworkError",
    });
  });

  test("an aborted signal propagates — never silently read as the tail", async () => {
    const storage = new MemoryStorage();
    await seedLogEntries(storage, PREFIX, 5, 8); // seqs 5..7 present

    await expect(
      probeTailFrom(storage, PREFIX, 5, { signal: AbortSignal.abort() }),
    ).rejects.toThrow(/abort/i);
  });
});

describe("findLogTail", () => {
  test("an always-occupied gallop exceeds the cap and throws Internal", async () => {
    // Every slot reads as occupied, so the gallop keeps doubling `step`
    // and never brackets an empty `hi`. It must surface the runaway as
    // `Internal` after `step` passes `LOG_FORWARD_PROBE_CAP` — not loop
    // forever. The gallop is `O(log cap)` GETs (~18), so this is fast and
    // never walks the full cap. A non-null body satisfies the
    // `get(...) !== null` occupancy probe.
    const alwaysOccupied: Storage = {
      get: async () => ({ body: new Uint8Array(0), etag: "x" }),
      put: async () => ({ etag: "x" }),
      delete: async () => {},
      list: () => {
        throw new Error("list not used by findLogTail");
      },
    };

    await expect(findLogTail(alwaysOccupied, PREFIX, 0)).rejects.toMatchObject({
      code: "Internal",
    });
  });
});
