import {
  GC_GRACE_PERIOD_MILLIS,
  GC_MAX_PENDING_CANDIDATES,
  MemoryStorage,
  casUpdateCurrentJson,
  createCurrentJson,
  readGcPending,
} from "@baerly/protocol";
import { expect, test } from "vitest";
import { logStateCurrentJson } from "../../../tests/fixtures/log-state.ts";
import { runGc, type InternalRunGcOptions } from "./gc.ts";
import { snapshotKey } from "./snapshot.ts";

test("real-grace GC keeps up with 225 replaced snapshots per day", async () => {
  // Ten writes/minute folded every 64 entries produce 225 snapshots/day.
  // Seed the fold's physical output directly to exercise weeks of real
  // grace without replaying hundreds of thousands of application writes.
  const DAYS = 42;
  const TICKS_PER_DAY = 15;
  const SNAPSHOTS_PER_TICK = 15;
  const SNAPSHOTS_PER_DAY = TICKS_PER_DAY * SNAPSHOTS_PER_TICK;
  const DAY_MILLIS = 24 * 60 * 60 * 1000;
  const GRACE_DAYS = GC_GRACE_PERIOD_MILLIS / DAY_MILLIS;
  const PREFIX = "app/throughput/tenant/t/manifests/c";
  const KEY = `${PREFIX}/current.json`;
  const SNAPSHOTS = `${PREFIX}/snapshot/L9/`;
  const storage = new MemoryStorage();
  await createCurrentJson(storage, KEY, logStateCurrentJson());
  let clock = Date.parse("2026-01-01T00:00:00Z");
  let seq = 0;
  const dailyCounts: number[] = [];
  for (let day = 0; day < DAYS; day++) {
    for (let tick = 0; tick < TICKS_PER_DAY; tick++) {
      clock += DAY_MILLIS / TICKS_PER_DAY;
      let liveSnapshot = "";
      for (let i = 0; i < SNAPSHOTS_PER_TICK; i++) {
        seq += 64;
        liveSnapshot = snapshotKey(PREFIX, 0, seq, "0".repeat(64));
        await storage.put(liveSnapshot, new Uint8Array());
      }
      await casUpdateCurrentJson(storage, KEY, (current) => ({
        ...current,
        snapshot: liveSnapshot,
        snapshot_bytes: 1,
        snapshot_rows: 1,
        log_seq_start: seq,
        tail_hint: seq,
      }));
      const result = await runGc({ storage, currentJsonKey: KEY }, {
        maxMarksPerRun: 200,
        maxSweepsPerRun: 100,
        now: () => new Date(clock),
      } as InternalRunGcOptions);
      expect(result.marked.orphan_snapshot).toBeLessThanOrEqual(200);
      expect(result.swept).toBeLessThanOrEqual(100);
      expect(
        (await readGcPending(storage, `${PREFIX}/gc/pending.json`))!.json.candidates.length,
      ).toBeLessThanOrEqual(GC_MAX_PENDING_CANDIDATES);
      await expect(storage.get(liveSnapshot)).resolves.not.toBeNull();
    }
    let count = 0;
    for await (const _ of storage.list(SNAPSHOTS)) {
      count++;
    }
    dailyCounts.push(count);
  }
  expect(
    Math.max(...dailyCounts.slice(2 * GRACE_DAYS)),
    `snapshot counts by day: ${dailyCounts.join(", ")}`,
  ).toBeLessThanOrEqual(SNAPSHOTS_PER_DAY * (2 * GRACE_DAYS + 1) + 1);
  const growth = dailyCounts.at(-1)! - dailyCounts.at(-8)!;
  expect(growth, `snapshot counts by day: ${dailyCounts.join(", ")}`).toBeLessThanOrEqual(
    SNAPSHOTS_PER_DAY,
  );
});
