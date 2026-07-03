/* eslint-disable no-underscore-dangle -- `_id` is the locked
   primary-key field on document shapes; this test threads it
   through writer + cost CLI. */

/**
 * CLI test for `baerly cost`.
 *
 * Provisions a fresh `LocalFsStorage` collection with N rows, runs
 * `runCost` programmatically, and asserts the projected trajectory
 * matches the requested provider's shape. Mirrors the trajectory
 * tests that used to live on `baerly inspect` before §G3 moved cost
 * projection behind its own verb.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  CURRENT_JSON_SCHEMA_VERSION,
  createCurrentJson,
  logObjectKey,
  type Storage,
} from "@baerly/protocol";
import { LocalFsStorage } from "@baerly/dev";
import { Writer } from "@baerly/server/_internal/testing";
import { runCost } from "./cost.ts";
import type { Trajectory } from "./cost/project.ts";
import { captureStream } from "./_internal/testing.ts";

const APP = "app";
const TENANT = "tenant";
const COLL = "tickets";
const TABLE_PREFIX = `app/${APP}/tenant/${TENANT}/manifests/${COLL}`;
const CURRENT_JSON_KEY = `${TABLE_PREFIX}/current.json`;

const provision = async (storage: Storage): Promise<void> => {
  await createCurrentJson(storage, CURRENT_JSON_KEY, {
    schema_version: CURRENT_JSON_SCHEMA_VERSION,
    snapshot: null,
    tail_hint: 0,
    log_seq_start: 0,
    writer_fence: { epoch: 0, owner: "cost-test", claimed_at: "" },
    snapshot_bytes: 0,
    snapshot_rows: 0,
  });
};

const seedEntries = async (storage: Storage, count: number): Promise<void> => {
  const writer = new Writer({ storage, currentJsonKey: CURRENT_JSON_KEY });
  for (let i = 0; i < count; i++) {
    await writer.commit({
      op: "I",
      collection: COLL,
      docId: `t-${i}`,
      body: { _id: `t-${i}`, title: `row ${i}` },
    });
    await new Promise((r) => setTimeout(r, 10));
  }
};

/**
 * Deterministically seed `count` log entries with explicit `commit_ts`
 * values inside a sub-second window, bypassing the real-clock `Writer`
 * path. `estimateWritesPerMin` floors its denominator to a 1 s window, so
 * the projected rate is a fixed `(count - 1) × 60` writes/min regardless
 * of wall-clock execution speed — no flake under CI load. Used by the
 * past-graduation suppression test, where the only thing that matters is
 * landing deterministically above the 50M Class A/mo hard trigger.
 */
const seedEntriesDeterministic = async (storage: Storage, count: number): Promise<void> => {
  const baseMs = Date.parse("2026-01-01T00:00:00.000Z");
  for (let seq = 0; seq < count; seq++) {
    const body = new TextEncoder().encode(
      JSON.stringify({
        lsn: `00000000_test_${String(seq).padStart(4, "0")}`,
        commit_ts: new Date(baseMs + seq).toISOString(),
        op: "I",
        collection: COLL,
        session: "cost-test",
        seq,
        doc_id: `t-${seq}`,
      }),
    );
    await storage.put(logObjectKey(TABLE_PREFIX, seq), body);
  }
};

describe("baerly cost", () => {
  let root: string;
  let storage: LocalFsStorage;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "baerly-cost-"));
    storage = new LocalFsStorage({ root });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("--provider=r2 with sufficient data emits a Trajectory in JSON envelope", async () => {
    await provision(storage);
    await seedEntries(storage, 3);

    const stdout = captureStream(process.stdout);
    let exitCode: number;
    try {
      exitCode = await runCost([
        `--bucket=file://${root}`,
        `--app=${APP}`,
        `--tenant=${TENANT}`,
        `--collection=${COLL}`,
        "--provider=r2",
        "--json",
      ]);
    } finally {
      stdout.restore();
    }
    expect(exitCode).toBe(0);
    const envelope = JSON.parse(stdout.captured.join("").trim()) as {
      result: { command: string; collection: string; trajectory: Trajectory };
    };
    expect(envelope.result.command).toBe("cost");
    expect(envelope.result.collection).toBe(COLL);
    expect(envelope.result.trajectory.provider).toBe("r2");
    expect(envelope.result.trajectory.classAPerMonth).toBeGreaterThan(0);
    expect(typeof envelope.result.trajectory.withinFreeTier).toBe("boolean");
  });

  test("--provider=r2 text mode renders a trajectory footer block", async () => {
    await provision(storage);
    await seedEntries(storage, 3);

    const stdout = captureStream(process.stdout);
    let exitCode: number;
    try {
      exitCode = await runCost([
        `--bucket=file://${root}`,
        `--app=${APP}`,
        `--tenant=${TENANT}`,
        `--collection=${COLL}`,
        "--provider=r2",
      ]);
    } finally {
      stdout.restore();
    }
    expect(exitCode).toBe(0);
    const text = stdout.captured.join("");
    expect(text).toContain("baerly cost tickets");
    expect(text).toContain("trajectory:");
    expect(text).toContain("writes/min");
    expect(text).toContain("Class A/mo");
  });

  test("--provider=self-hosted emits a Trajectory with null usd", async () => {
    await provision(storage);
    await seedEntries(storage, 3);

    const stdout = captureStream(process.stdout);
    let exitCode: number;
    try {
      exitCode = await runCost([
        `--bucket=file://${root}`,
        `--app=${APP}`,
        `--tenant=${TENANT}`,
        `--collection=${COLL}`,
        "--provider=self-hosted",
        "--json",
      ]);
    } finally {
      stdout.restore();
    }
    expect(exitCode).toBe(0);
    const envelope = JSON.parse(stdout.captured.join("").trim()) as {
      result: { trajectory: Trajectory };
    };
    expect(envelope.result.trajectory.provider).toBe("self-hosted");
    expect(envelope.result.trajectory.projectedUsdPerMonth).toBeNull();
    expect(envelope.result.trajectory.percentOfGraduation).toBeGreaterThanOrEqual(0);
  });

  test("--provider=aws-s3 emits a paid Trajectory (no free tier)", async () => {
    await provision(storage);
    await seedEntries(storage, 3);

    const stdout = captureStream(process.stdout);
    let exitCode: number;
    try {
      exitCode = await runCost([
        `--bucket=file://${root}`,
        `--app=${APP}`,
        `--tenant=${TENANT}`,
        `--collection=${COLL}`,
        "--provider=aws-s3",
        "--json",
      ]);
    } finally {
      stdout.restore();
    }
    expect(exitCode).toBe(0);
    const envelope = JSON.parse(stdout.captured.join("").trim()) as {
      result: { trajectory: Trajectory };
    };
    expect(envelope.result.trajectory.provider).toBe("aws-s3");
    expect(envelope.result.trajectory.withinFreeTier).toBe(false);
    expect(envelope.result.trajectory.projectedUsdPerMonth).toBeGreaterThan(0);
  });

  test("dev backend (file://) without --provider override exits 1 (InvalidConfig)", async () => {
    await provision(storage);
    await seedEntries(storage, 3);

    const stderr = captureStream(process.stderr);
    let exitCode: number;
    try {
      exitCode = await runCost([
        `--bucket=file://${root}`,
        `--app=${APP}`,
        `--tenant=${TENANT}`,
        `--collection=${COLL}`,
      ]);
    } finally {
      stderr.restore();
    }
    expect(exitCode).toBe(1);
    expect(stderr.captured.join("")).toContain("InvalidConfig");
  });

  test("--provider=r2 with <2 log entries exits 1 (InvalidConfig)", async () => {
    await provision(storage);

    const stderr = captureStream(process.stderr);
    let exitCode: number;
    try {
      exitCode = await runCost([
        `--bucket=file://${root}`,
        `--app=${APP}`,
        `--tenant=${TENANT}`,
        `--collection=${COLL}`,
        "--provider=r2",
      ]);
    } finally {
      stderr.restore();
    }
    expect(exitCode).toBe(1);
    expect(stderr.captured.join("")).toContain("InvalidConfig");
    expect(stderr.captured.join("")).toContain("not enough log entries");
  });

  test("unknown --provider rejected with exit 1", async () => {
    const stderr = captureStream(process.stderr);
    let exitCode: number;
    try {
      exitCode = await runCost([
        `--bucket=file://${root}`,
        `--app=${APP}`,
        `--tenant=${TENANT}`,
        `--collection=${COLL}`,
        "--provider=not-a-real-provider",
      ]);
    } finally {
      stderr.restore();
    }
    expect(exitCode).toBe(1);
    expect(stderr.captured.join("")).toContain("--provider must be one of");
  });

  test("missing --app/--tenant + no baerly.config surfaces InvalidConfig (exit 1)", async () => {
    await provision(storage);
    await seedEntries(storage, 3);

    // Use a tmp cwd so the cwd-based config search misses (the test
    // root's cwd may have unrelated configs).
    const cwdBefore = process.cwd();
    const cwdDir = await mkdtemp(join(tmpdir(), "baerly-cost-cwd-"));
    process.chdir(cwdDir);
    const stderr = captureStream(process.stderr);
    let exitCode: number;
    try {
      exitCode = await runCost([
        `--bucket=file://${root}`,
        `--collection=${COLL}`,
        "--provider=r2",
      ]);
    } finally {
      stderr.restore();
      process.chdir(cwdBefore);
      await rm(cwdDir, { recursive: true, force: true });
    }
    expect(exitCode).toBe(1);
    expect(stderr.captured.join("")).toContain("InvalidConfig");
  });

  test("traversal-shaped --collection rejected → InvalidConfig (exit 1)", async () => {
    // `cost` must reject a traversal collection segment via the same
    // shared rule, before it builds a `../current.json`-shaped key.
    await provision(storage);
    const stderr = captureStream(process.stderr);
    let exitCode: number;
    try {
      exitCode = await runCost([
        `--bucket=file://${root}`,
        `--app=${APP}`,
        `--tenant=${TENANT}`,
        `--collection=..`,
        "--provider=r2",
      ]);
    } finally {
      stderr.restore();
    }
    expect(exitCode).toBe(1);
    const msg = stderr.captured.join("");
    expect(msg).toContain("InvalidConfig");
    expect(msg).toContain("baerly cost");
    expect(msg).toContain("collection");
  });

  test("unknown flag rejected with exit 1", async () => {
    const stderr = captureStream(process.stderr);
    let exitCode: number;
    try {
      exitCode = await runCost([
        `--bucket=file://${root}`,
        `--app=${APP}`,
        `--tenant=${TENANT}`,
        `--collection=${COLL}`,
        "--provider=r2",
        "--unknown=oops",
      ]);
    } finally {
      stderr.restore();
    }
    expect(exitCode).toBe(1);
    expect(stderr.captured.join("")).toContain("unknown flag");
  });

  // Advisory render tests: 3 entries at 10ms spacing → very high write rate
  // (well above the 100 writes/min advisory threshold), so advisory renders.
  test("--provider=r2 text mode: advisory renders when past 100 writes/min (high write rate)", async () => {
    await provision(storage);
    await seedEntries(storage, 3);

    const stdout = captureStream(process.stdout);
    let exitCode: number;
    try {
      exitCode = await runCost([
        `--bucket=file://${root}`,
        `--app=${APP}`,
        `--tenant=${TENANT}`,
        `--collection=${COLL}`,
        "--provider=r2",
      ]);
    } finally {
      stdout.restore();
    }
    expect(exitCode).toBe(0);
    const text = stdout.captured.join("");
    // The high rate (>> 100 writes/min) should trigger the advisory.
    expect(text).toContain("advisory:");
    expect(text).toContain("~$54/mo on R2");
    expect(text).toContain("50M Class A/mo");
  });

  test("--provider=aws-s3 text mode: advisory shows S3 figure (~$86/mo on S3), not R2", async () => {
    await provision(storage);
    await seedEntries(storage, 3);

    const stdout = captureStream(process.stdout);
    let exitCode: number;
    try {
      exitCode = await runCost([
        `--bucket=file://${root}`,
        `--app=${APP}`,
        `--tenant=${TENANT}`,
        `--collection=${COLL}`,
        "--provider=aws-s3",
      ]);
    } finally {
      stdout.restore();
    }
    expect(exitCode).toBe(0);
    const text = stdout.captured.join("");
    // High rate (>> 100 writes/min) should trigger the advisory.
    expect(text).toContain("advisory:");
    expect(text).toContain("~$86/mo on S3");
    // Must NOT show the R2 figure for an S3 user.
    expect(text).not.toContain("~$54/mo on R2");
    // The hard-trigger line must not leak an R2 dollar figure either.
    expect(text).not.toContain("on R2");
    expect(text).toContain("50M Class A/mo");
  });

  test("--provider=r2 JSON mode: trajectory includes percentOfAdvisory field", async () => {
    await provision(storage);
    await seedEntries(storage, 3);

    const stdout = captureStream(process.stdout);
    let exitCode: number;
    try {
      exitCode = await runCost([
        `--bucket=file://${root}`,
        `--app=${APP}`,
        `--tenant=${TENANT}`,
        `--collection=${COLL}`,
        "--provider=r2",
        "--json",
      ]);
    } finally {
      stdout.restore();
    }
    expect(exitCode).toBe(0);
    const envelope = JSON.parse(stdout.captured.join("").trim()) as {
      result: { trajectory: Trajectory };
    };
    expect(typeof envelope.result.trajectory.percentOfAdvisory).toBe("number");
    expect(Number.isFinite(envelope.result.trajectory.percentOfAdvisory)).toBe(true);
    // High rate → well above advisory threshold.
    expect(envelope.result.trajectory.percentOfAdvisory).toBeGreaterThan(100);
  });

  test("--provider=r2 text mode: advisory does NOT render when below the 100 writes/min advisory threshold", async () => {
    await provision(storage);
    // Seed 2 entries with a ~1.5s gap so that the estimated rate stays
    // below the advisory threshold:
    //   writesPerMin = 1 / (1500ms / 60000ms) = 40 writes/min < 100 (advisory).
    const writer = new Writer({ storage, currentJsonKey: CURRENT_JSON_KEY });
    await writer.commit({
      op: "I",
      collection: COLL,
      docId: "t-0",
      body: { _id: "t-0", title: "row 0" },
    });
    // Slow (real-clock) low-rate probe: 1.5s gap → ~40 writes/min, deterministically
    // below the 100 writes/min advisory threshold. renderTrajectory isn't exported and no clock
    // seam exists, so the rate is produced through the real estimateWritesPerMin path.
    await new Promise((r) => setTimeout(r, 1500));
    await writer.commit({
      op: "I",
      collection: COLL,
      docId: "t-1",
      body: { _id: "t-1", title: "row 1" },
    });

    const stdout = captureStream(process.stdout);
    let exitCode: number;
    try {
      exitCode = await runCost([
        `--bucket=file://${root}`,
        `--app=${APP}`,
        `--tenant=${TENANT}`,
        `--collection=${COLL}`,
        "--provider=r2",
      ]);
    } finally {
      stdout.restore();
    }
    expect(exitCode).toBe(0);
    const text = stdout.captured.join("");
    expect(text).toContain("trajectory:");
    // Rate is below advisory → no advisory block.
    expect(text).not.toContain("advisory:");
  });

  test("--provider=r2 text mode: advisory suppressed once past the 50M/mo graduation trigger", async () => {
    await provision(storage);
    // Deterministic: 10 entries inside a sub-second window → the estimator
    // floors its denominator to a 1 s window → exactly 9 × 60 = 540 writes/min
    // → ~70M Class A/mo (×3) ⇒ percentOfGraduation ≈ 140%, well past 100 and
    // independent of wall-clock execution speed. renderAdvisoryLine suppresses
    // the advisory above the hard trigger (percentOfGraduation ≥ 100 guard);
    // project.test.ts proves the math at the projection layer, this exercises
    // the render-layer suppression branch.
    await seedEntriesDeterministic(storage, 10);

    const stdout = captureStream(process.stdout);
    let exitCode: number;
    try {
      exitCode = await runCost([
        `--bucket=file://${root}`,
        `--app=${APP}`,
        `--tenant=${TENANT}`,
        `--collection=${COLL}`,
        "--provider=r2",
      ]);
    } finally {
      stdout.restore();
    }
    expect(exitCode).toBe(0);
    const text = stdout.captured.join("");
    expect(text).toContain("trajectory:");
    expect(text).toContain("50M/mo graduation trigger");
    // Past the hard trigger → advisory block suppressed (percentOfGraduation >= 100 guard).
    expect(text).not.toContain("advisory:");
  });

  test("--provider=self-hosted text mode: advisory renders for self-hosted when past threshold", async () => {
    await provision(storage);
    await seedEntries(storage, 3);

    const stdout = captureStream(process.stdout);
    let exitCode: number;
    try {
      exitCode = await runCost([
        `--bucket=file://${root}`,
        `--app=${APP}`,
        `--tenant=${TENANT}`,
        `--collection=${COLL}`,
        "--provider=self-hosted",
      ]);
    } finally {
      stdout.restore();
    }
    expect(exitCode).toBe(0);
    const text = stdout.captured.join("");
    // advisory should appear for self-hosted too (without $/mo figure).
    expect(text).toContain("advisory:");
    expect(text).toContain("bill model not modelled");
    // No $/mo figure in self-hosted advisory.
    expect(text).not.toContain("~$54/mo on R2");
  });

  test("--provider=self-hosted JSON mode: trajectory includes percentOfAdvisory field", async () => {
    await provision(storage);
    await seedEntries(storage, 3);

    const stdout = captureStream(process.stdout);
    let exitCode: number;
    try {
      exitCode = await runCost([
        `--bucket=file://${root}`,
        `--app=${APP}`,
        `--tenant=${TENANT}`,
        `--collection=${COLL}`,
        "--provider=self-hosted",
        "--json",
      ]);
    } finally {
      stdout.restore();
    }
    expect(exitCode).toBe(0);
    const envelope = JSON.parse(stdout.captured.join("").trim()) as {
      result: { trajectory: Trajectory };
    };
    expect(typeof envelope.result.trajectory.percentOfAdvisory).toBe("number");
    expect(Number.isFinite(envelope.result.trajectory.percentOfAdvisory)).toBe(true);
  });
});
