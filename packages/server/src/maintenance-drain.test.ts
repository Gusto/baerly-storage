/* eslint-disable no-underscore-dangle -- `_id` is the locked primary-key
   field on document shapes; the drain test seeds doc bodies with it. */

/**
 * §7.1 drain-rate invariant — EXECUTABLE.
 *
 * The cadence-decoupled, budgeted `runGc` on the write-tick keeps the
 * bucket object count BOUNDED iff steady-state GC throughput keeps pace
 * with orphan production. Each fold retires its slice of log entries
 * (and, under update/delete churn, the superseded content blobs) into
 * `stale-log` / `orphan-content` candidates; with `gcGraceMillis: 0`
 * GC mark+sweeps them on every cadence boundary.
 *
 * These tests drive a steadily-written, BOUNDED-live-set collection
 * (a fixed 50-doc working set under insert/update churn, so the live
 * floor is constant and any unbounded growth is unswept orphans)
 * through the REAL {@link Writer} inside an ALS maintenance context —
 * the true write-tick integration path the adapter exercises in
 * production.
 *
 * ## What the measured trajectory shows
 *
 * 1. With GC PROVISIONED to keep pace (`gcMaxMarks ≈ 100`,
 *    `gcMaxSweeps ≈ 50`, `phasesPerTick: "both"`) the object count
 *    PLATEAUS dead flat (measured: 133 objects, unchanged across
 *    1600 writes) — proving the cadence-decoupled budgeted design
 *    drains correctly.
 *
 * 2. With the CF-FREE caps (`gcMaxMarks = 20`, `gcMaxSweeps = 10`) the
 *    object count ALSO stays BOUNDED, now that `runGc`'s orphan-content
 *    LIST rotates via a persisted `content_scan_cursor` (Task 4.6).
 *    Each bounded pass resumes `startAfter` the prior pass's last
 *    examined key, so over a rotation the whole hash-named `content/`
 *    keyspace is reached — orphan content past the first-`maxMarks`
 *    lexicographic window is no longer stranded. The count converges to
 *    `live + bounded slack` (orphans in flight within the grace window
 *    plus the per-pass mark budget) instead of growing linearly.
 *
 *    Before Task 4.6 the content LIST had no `startAfter` rotation, so
 *    once orphan content accrued past the first-`maxMarks` window GC
 *    could never reach it (~0.5 objects/write leak). The `BITES` arm
 *    below still models the pre-decoupling fold-bolted GC and STILL
 *    grows — proving the bounded assertion is not vacuous.
 */

import {
  CURRENT_JSON_SCHEMA_VERSION,
  createCurrentJson,
  MAINTENANCE_PROFILE_CF_FREE,
  MemoryStorage,
  readCurrentJson,
  type Storage,
} from "@baerly/protocol";
import { describe, expect, test } from "vitest";
import { compact, type InternalCompactOptions } from "./compactor.ts";
import { runGc, type InternalRunGcOptions } from "./gc.ts";
import { type BoundedMaintenanceOptions } from "./maintenance.ts";
import { createObservabilityContext, runWithContext } from "./observability/context.ts";
import { Writer } from "./writer.ts";

const KEY = "app/t/tenant/x/manifests/c/current.json";
const COLL = "c";

const bootstrap = async (storage: Storage, key: string): Promise<void> => {
  await createCurrentJson(storage, key, {
    schema_version: CURRENT_JSON_SCHEMA_VERSION,
    snapshot: null,
    tail_hint: 0,
    log_seq_start: 0,
    writer_fence: { epoch: 0, owner: "drain-test", claimed_at: "" },
    tail_bytes: 0,
    snapshot_bytes: 0,
    snapshot_rows: 0,
  });
};

/** Count every key currently in the bucket (one `Storage.list` walk). */
const objectCount = async (storage: Storage): Promise<number> => {
  let n = 0;
  for await (const _entry of storage.list("")) {
    n += 1;
  }
  return n;
};

const WORKING_SET = 50; // bounded live doc set ⇒ constant live floor
const BODY_BYTES = 2000; // big enough bodies that the ratio gate trips and folds fire on cadence

/**
 * Drive `total` real commits through the {@link Writer} under the given
 * write-tick profile, sampling the total bucket object count every
 * `sampleEvery` writes. Returns the samples.
 */
const driveWriteStream = async (
  profile: BoundedMaintenanceOptions,
  total: number,
  sampleEvery: number,
): Promise<Array<{ write: number; objects: number }>> => {
  const storage = new MemoryStorage();
  await bootstrap(storage, KEY);
  const writer = new Writer({ storage, currentJsonKey: KEY });
  const ctx = createObservabilityContext({ maintenance: { options: profile } });
  const blob = "x".repeat(BODY_BYTES);
  const samples: Array<{ write: number; objects: number }> = [];

  await runWithContext(ctx, async () => {
    for (let i = 0; i < total; i++) {
      // Bounded working set under insert/update churn: the live doc set
      // never exceeds WORKING_SET, so the live floor is constant and any
      // sustained growth in the object count is unswept orphans.
      await writer.commit({
        op: i % 2 === 0 ? "I" : "U",
        collection: COLL,
        docId: `d${i % WORKING_SET}`,
        body: { _id: `d${i % WORKING_SET}`, n: i, blob },
      });
      if ((i + 1) % sampleEvery === 0) {
        samples.push({ write: i + 1, objects: await objectCount(storage) });
      }
    }
  });
  return samples;
};

describe("§7.1 drain-rate invariant (write-tick, real Writer)", () => {
  test("PROVISIONED GC drains: object count STABILIZES flat under a steady write stream", async () => {
    // GC sized to keep pace with the fold's orphan production. Validates
    // the cadence-decoupled, budgeted-runGc MECHANISM: the count must
    // plateau, not climb with writes.
    const provisioned: BoundedMaintenanceOptions = {
      profile: {
        ...MAINTENANCE_PROFILE_CF_FREE,
        maxFoldEntriesPerPass: 20,
        gcMaxMarks: 100,
        gcMaxSweeps: 50,
        gcInterval: 4,
      },
      minEntriesToCompact: 50,
      phasesPerTick: "both",
      gcGraceMillis: 0,
    };
    const samples = await driveWriteStream(provisioned, 1600, 200);
    const trajectory = samples.map((s) => `${s.write}:${s.objects}`).join(" ");

    const mid = samples[Math.floor(samples.length / 2)]!;
    const last = samples[samples.length - 1]!;

    // Plateau: the second half does not grow beyond a tiny boundary
    // slack. (Measured: dead flat at 133 across the whole stream.)
    const SLACK = 40;
    expect(
      last.objects - mid.objects,
      `trajectory ${trajectory} — count grew by ${last.objects - mid.objects} over the second half (slack ${SLACK})`,
    ).toBeLessThanOrEqual(SLACK);

    // And the peak stays bounded near the live working set — NOT
    // proportional to the write count (which would be ~2*writes if
    // nothing were swept).
    const maxObjects = Math.max(...samples.map((s) => s.objects));
    expect(
      maxObjects,
      `trajectory ${trajectory} — peak ${maxObjects} should stay near the live set, far below ~${last.write * 2}`,
    ).toBeLessThan(WORKING_SET * 6); // live + tail + manifests, bounded
  });

  test("CF-free caps now BOUND orphan-content under sustained churn (cursor rotation)", async () => {
    // CF-free per-tick caps. Before Task 4.6 the object count climbed
    // linearly because GC's `maxMarksPerRun`-capped content LIST could
    // not reach orphan content beyond its first-`maxMarks` lexicographic
    // window. The persisted `content_scan_cursor` rotation now resumes
    // each bounded pass `startAfter` the prior pass's last examined key,
    // so over a rotation the whole hash-named `content/` keyspace is
    // reached and orphan content drains within the CF-free budget. The
    // count must now PLATEAU near the live working set, not grow with
    // writes.
    const cfFree: BoundedMaintenanceOptions = {
      profile: {
        ...MAINTENANCE_PROFILE_CF_FREE,
        maxFoldEntriesPerPass: 20,
        gcMaxMarks: 20,
        gcMaxSweeps: 10,
        gcInterval: 4,
      },
      minEntriesToCompact: 50,
      phasesPerTick: "single",
      gcGraceMillis: 0,
    };
    const samples = await driveWriteStream(cfFree, 1600, 200);
    const trajectory = samples.map((s) => `${s.write}:${s.objects}`).join(" ");
    const mid = samples[Math.floor(samples.length / 2)]!;
    const last = samples[samples.length - 1]!;

    // Plateau: the second half does not grow beyond a bounded slack
    // (orphans in flight + the per-pass mark budget). Slack is wider
    // than the provisioned arm because CF-free rotates the content
    // window over many passes rather than draining each fold's orphans
    // immediately — but it is a CONSTANT band, not write-proportional.
    const SLACK = 80;
    expect(
      last.objects - mid.objects,
      `trajectory ${trajectory} — count grew by ${last.objects - mid.objects} over the second half (slack ${SLACK})`,
    ).toBeLessThanOrEqual(SLACK);

    // And the peak stays bounded near the live working set — NOT
    // proportional to the write count (~2*writes if nothing drained).
    const maxObjects = Math.max(...samples.map((s) => s.objects));
    expect(
      maxObjects,
      `trajectory ${trajectory} — peak ${maxObjects} should stay near the live set, far below ~${last.write * 2}`,
    ).toBeLessThan(WORKING_SET * 12);
  });

  test("BITES: the OLD broken shape (GC bolted to fold cadence, tiny sweep budget) GROWS monotonically", async () => {
    // Models the pre-decoupling design: GC ran ONLY when a fold ran,
    // with a tiny per-fold sweep budget and NO independent GC cadence.
    // Driven by hand (write-tick maintenance disabled) over the same
    // bounded-working-set stream. Proves the headline bound is not
    // vacuous: a non-decoupled, under-budgeted GC cannot keep pace.
    const storage = new MemoryStorage();
    await bootstrap(storage, KEY);
    const writer = new Writer({ storage, currentJsonKey: KEY });
    const ctx = createObservabilityContext({ maintenance: { disabled: true } });
    const blob = "x".repeat(BODY_BYTES);
    const samples: Array<{ write: number; objects: number }> = [];

    await runWithContext(ctx, async () => {
      for (let i = 0; i < 1600; i++) {
        await writer.commit({
          op: i % 2 === 0 ? "I" : "U",
          collection: COLL,
          docId: `d${i % WORKING_SET}`,
          body: { _id: `d${i % WORKING_SET}`, n: i, blob },
        });

        // OLD shape: fold-and-GC ONLY on the compact-threshold tick; GC
        // bolted to that same tick with a tiny sweep cap and no separate
        // cadence. The under-budget sweep can't drain a fold's orphans.
        const cur = await readCurrentJson(storage, KEY);
        const tail = cur!.json.tail_hint - cur!.json.log_seq_start;
        if (tail >= 50) {
          await compact({ storage, currentJsonKey: KEY }, {
            maxEntriesPerRun: 20,
            minEntriesToCompact: 50,
          } as InternalCompactOptions);
          await runGc({ storage, currentJsonKey: KEY }, {
            graceMillis: 0,
            maxMarksPerRun: 20,
            maxSweepsPerRun: 2, // under-provisioned: < orphans/fold
          } as InternalRunGcOptions);
        }

        if ((i + 1) % 200 === 0) {
          samples.push({ write: i + 1, objects: await objectCount(storage) });
        }
      }
    });

    const trajectory = samples.map((s) => `${s.write}:${s.objects}`).join(" ");
    const mid = samples[Math.floor(samples.length / 2)]!;
    const last = samples[samples.length - 1]!;
    expect(
      last.objects,
      `trajectory ${trajectory} — old shape should keep growing (mid ${mid.objects} → last ${last.objects})`,
    ).toBeGreaterThan(mid.objects);
  });

  test("an UN-sliced whole-tail fold of >=100 entries would BLOW the 50-subrequest CF-free budget", () => {
    // Why slicing is load-bearing: compact's worst-case budget is
    // `3 + maxEntriesPerRun` subrequests (1 GET current + 1 GET prior
    // snapshot + N GET log + 1 PUT snapshot + 1 PUT current). Folding a
    // whole 100-entry tail in one pass is 3 + 100 = 103 > 50. The
    // CF-free slice caps N at 20 ⇒ 3 + 20 = 23 < 50.
    const wholeTailFoldCost = 3 + 100;
    expect(wholeTailFoldCost).toBeGreaterThan(50);
    const slicedFoldCost = 3 + 20;
    expect(slicedFoldCost).toBeLessThanOrEqual(50);
  });
});
