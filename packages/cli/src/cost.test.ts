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
import { CURRENT_JSON_SCHEMA_VERSION, createCurrentJson, type Storage } from "@baerly/protocol";
import { LocalFsStorage } from "@baerly/dev";
import { Writer } from "@baerly/server/_internal/testing";
import { runCost } from "./cost.ts";
import type { Trajectory } from "./cost/project.ts";

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
    tail_bytes: 0,
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

const captureStream = (
  stream: NodeJS.WriteStream,
): { restore: () => void; readonly captured: string[] } => {
  const captured: string[] = [];
  const original = stream.write.bind(stream);
  stream.write = ((chunk: unknown): boolean => {
    captured.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof stream.write;
  return {
    captured,
    restore: () => {
      stream.write = original;
    },
  };
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
    const exitCode = await runCost([
      `--bucket=file://${root}`,
      `--app=${APP}`,
      `--tenant=${TENANT}`,
      `--collection=${COLL}`,
      "--provider=r2",
      "--unknown=oops",
    ]);
    expect(exitCode).toBe(1);
  });
});
