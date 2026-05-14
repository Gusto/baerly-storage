/**
 * Unit tests for the `baerly doctor --usage` writes/min estimator.
 *
 * Drives `MemoryStorage` directly so the suite has zero infra deps
 * and runs in the default vitest project. Log entries are seeded as
 * raw `LogEntry` JSON under the canonical
 * `app/<app>/tenant/<tenant>/manifests/<collection>/log/<seq>.json`
 * key shape (see `docs/spec/log-entry-shape.md` and
 * `packages/server/src/server-writer.ts:643`); driving a real
 * `ServerWriter` here would force a `current.json` bootstrap +
 * full CAS cycle per write, which buys nothing for this estimator
 * test — the writer is not under test.
 */

import { describe, expect, test } from "vitest";
import { MemoryStorage, type LogEntry } from "@baerly/protocol";
import {
  M_SIZE_WRITES_PER_MIN_PER_COLLECTION,
  discoverCollections,
  estimateWritesPerMin,
} from "./usage.ts";

interface SeedOpts {
  readonly count: number;
  /** Spread between the first and last commit_ts (real minutes). */
  readonly windowMinutes: number;
  /** First commit_ts in epoch-ms; defaults to a stable fixture date. */
  readonly startMs?: number;
}

const seedLogEntries = async (
  storage: MemoryStorage,
  app: string,
  tenant: string,
  collection: string,
  opts: SeedOpts,
): Promise<void> => {
  const { count, windowMinutes } = opts;
  const startMs = opts.startMs ?? Date.UTC(2026, 0, 1, 0, 0, 0);
  const prefix = `app/${app}/tenant/${tenant}/manifests/${collection}/log`;
  for (let seq = 0; seq < count; seq++) {
    const t =
      count === 1 ? startMs : startMs + Math.round((seq * windowMinutes * 60_000) / (count - 1));
    const entry: LogEntry = {
      lsn: `dummy_${seq.toString(16).padStart(6, "0")}_00`,
      commit_ts: new Date(t).toISOString(),
      op: "I",
      collection,
      doc_id: `doc_${seq}`,
      schema_version: 0,
      session: "abcdef",
      seq,
      new: { value: seq },
      patch: { value: seq },
    };
    await storage.put(`${prefix}/${seq}.json`, new TextEncoder().encode(JSON.stringify(entry)), {
      contentType: "application/json",
    });
  }
};

describe("estimateWritesPerMin", () => {
  test("info severity when below 50% of the M-size ceiling", async () => {
    const storage = new MemoryStorage();
    // 10 writes spread over 60 minutes -> 9/60 = 0.15 writes/min,
    // ~0.5% of the 30/min ceiling. Well under 50%.
    await seedLogEntries(storage, "myapp", "tenant1", "tickets", {
      count: 10,
      windowMinutes: 60,
    });
    const v = await estimateWritesPerMin(storage, "myapp", "tenant1", "tickets");
    expect(v.collection).toBe("tickets");
    expect(v.severity).toBe("info");
    expect(v.percentOfCeiling).toBeLessThan(50);
    expect(v.writesPerMin).toBeCloseTo(0.15, 1);
    expect(v.fix).toBe("");
  });

  test("warning severity (approaching) between 50% and 100%", async () => {
    const storage = new MemoryStorage();
    // 21 entries over 1 minute -> 20 writes/min -> ~67% of ceiling.
    await seedLogEntries(storage, "x", "y", "tickets", {
      count: 21,
      windowMinutes: 1,
    });
    const v = await estimateWritesPerMin(storage, "x", "y", "tickets");
    expect(v.severity).toBe("warning");
    expect(v.percentOfCeiling).toBeGreaterThanOrEqual(50);
    expect(v.percentOfCeiling).toBeLessThan(100);
    expect(v.message).toContain("approaching");
    expect(v.fix).toMatch(/baerly export/);
  });

  test("warning severity + export fix when above ceiling", async () => {
    const storage = new MemoryStorage();
    // 46 entries over 1 minute -> 45 writes/min -> 150% of ceiling.
    await seedLogEntries(storage, "x", "y", "tickets", {
      count: 46,
      windowMinutes: 1,
    });
    const v = await estimateWritesPerMin(storage, "x", "y", "tickets");
    expect(v.severity).toBe("warning");
    expect(v.percentOfCeiling).toBeGreaterThanOrEqual(100);
    expect(v.message).toContain("exceeds");
    expect(v.fix).toMatch(/baerly export/);
    expect(v.fix).toMatch(/--table=tickets/);
  });

  test("info NaN verdict when fewer than 2 entries seen", async () => {
    const storage = new MemoryStorage();
    await seedLogEntries(storage, "x", "y", "z", { count: 1, windowMinutes: 1 });
    const v = await estimateWritesPerMin(storage, "x", "y", "z");
    expect(Number.isNaN(v.writesPerMin)).toBe(true);
    expect(Number.isNaN(v.percentOfCeiling)).toBe(true);
    expect(v.severity).toBe("info");
    expect(v.message).toContain("not enough log entries");
  });

  test("info NaN verdict when no log entries at all", async () => {
    const storage = new MemoryStorage();
    const v = await estimateWritesPerMin(storage, "x", "y", "z");
    expect(Number.isNaN(v.writesPerMin)).toBe(true);
    expect(v.severity).toBe("info");
    expect(v.message).toContain("saw 0");
  });

  test("seq-numeric ordering survives past seq=9 (lex vs numeric)", async () => {
    // 12 entries means seqs 0..11; lex order puts log/10.json before
    // log/2.json. Verify we still pick the right tail.
    const storage = new MemoryStorage();
    await seedLogEntries(storage, "x", "y", "z", {
      count: 12,
      windowMinutes: 11, // 1 entry per minute
    });
    const v = await estimateWritesPerMin(storage, "x", "y", "z");
    expect(v.severity).toBe("info");
    // 11 intervals over 11 minutes = 1.0 writes/min.
    expect(v.writesPerMin).toBeCloseTo(1.0, 2);
  });

  test("sampleSize caps the read window", async () => {
    const storage = new MemoryStorage();
    // 30 entries over 30 minutes (~1/min). Sample only the last 6 of
    // them -> still ~1/min (5 intervals over the trailing 5 min).
    await seedLogEntries(storage, "x", "y", "z", {
      count: 30,
      windowMinutes: 29, // one per minute
    });
    const v = await estimateWritesPerMin(storage, "x", "y", "z", { sampleSize: 6 });
    expect(v.severity).toBe("info");
    expect(v.writesPerMin).toBeCloseTo(1.0, 2);
  });

  test("M_SIZE_WRITES_PER_MIN_PER_COLLECTION matches the documented thesis", () => {
    expect(M_SIZE_WRITES_PER_MIN_PER_COLLECTION).toBe(30);
  });
});

describe("discoverCollections", () => {
  test("finds each immediate subdirectory under manifests/", async () => {
    const storage = new MemoryStorage();
    await seedLogEntries(storage, "x", "y", "tickets", { count: 2, windowMinutes: 1 });
    await seedLogEntries(storage, "x", "y", "comments", { count: 2, windowMinutes: 1 });
    // Also put a current.json so the discovery still picks the
    // collection up via the manifests/ prefix walk.
    await storage.put(
      "app/x/tenant/y/manifests/users/current.json",
      new TextEncoder().encode(JSON.stringify({ schema_version: 1 })),
    );
    const names = await discoverCollections(storage, "x", "y");
    expect(names).toEqual(["comments", "tickets", "users"]);
  });

  test("returns empty list when no manifests/ keys exist", async () => {
    const storage = new MemoryStorage();
    const names = await discoverCollections(storage, "x", "y");
    expect(names).toEqual([]);
  });

  test("isolates by tenant", async () => {
    const storage = new MemoryStorage();
    await seedLogEntries(storage, "x", "alice", "tickets", { count: 2, windowMinutes: 1 });
    await seedLogEntries(storage, "x", "bob", "comments", { count: 2, windowMinutes: 1 });
    expect(await discoverCollections(storage, "x", "alice")).toEqual(["tickets"]);
    expect(await discoverCollections(storage, "x", "bob")).toEqual(["comments"]);
  });
});
