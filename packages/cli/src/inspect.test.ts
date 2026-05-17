/* eslint-disable no-underscore-dangle -- `_id` is the locked
   primary-key field on document shapes; this test threads it
   through writer + inspect CLI. */

/**
 * CLI test for `baerly inspect`.
 *
 * Provisions a fresh `LocalFsStorage` collection with N rows, runs
 * `runInspect` programmatically, and asserts the JSON envelope's
 * row count / next_seq / log_seq_start. A second test injects an
 * orphan snapshot file and asserts `status: "error"` with the
 * orphan path enumerated in `errors`.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { CURRENT_JSON_SCHEMA_VERSION, createCurrentJson, type Storage } from "@baerly/protocol";
import { LocalFsStorage } from "@baerly/dev";
import { ServerWriter } from "@baerly/server";
import { runInspect } from "./inspect.ts";
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
    next_seq: 0,
    log_seq_start: 0,
    writer_fence: { epoch: 0, owner: "inspect-test", claimed_at: "" },
  });
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

describe("baerly inspect", () => {
  let root: string;
  let storage: LocalFsStorage;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "baerly-inspect-"));
    storage = new LocalFsStorage({ root });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("reports row count + next_seq + log_seq_start in JSON envelope", async () => {
    await provision(storage);
    const writer = new ServerWriter({ storage, currentJsonKey: CURRENT_JSON_KEY });
    await writer.commit({
      op: "I",
      collection: COLL,
      docId: "t-1",
      body: { _id: "t-1", title: "first", status: "open" },
    });
    await writer.commit({
      op: "I",
      collection: COLL,
      docId: "t-2",
      body: { _id: "t-2", title: "second", status: "closed" },
    });

    const stdout = captureStream(process.stdout);
    let exitCode: number;
    try {
      exitCode = await runInspect([
        `--bucket=file://${root}`,
        `--app=${APP}`,
        `--tenant=${TENANT}`,
        `--table=${COLL}`,
        "--json",
      ]);
    } finally {
      stdout.restore();
    }
    expect(exitCode).toBe(0);
    const envelope = JSON.parse(stdout.captured.join("").trim()) as {
      result: {
        command: string;
        currentJsonKey: string;
        materialised_rows: number;
        next_seq: number;
        log_seq_start: number;
        live_log_tail: number;
        snapshot: string | null;
        status: string;
        errors: string[];
      };
    };
    expect(envelope.result.command).toBe("inspect");
    expect(envelope.result.currentJsonKey).toBe(CURRENT_JSON_KEY);
    expect(envelope.result.materialised_rows).toBe(2);
    expect(envelope.result.next_seq).toBe(2);
    expect(envelope.result.log_seq_start).toBe(0);
    expect(envelope.result.live_log_tail).toBe(2);
    expect(envelope.result.snapshot).toBe(null);
    expect(envelope.result.status).toBe("ok");
    expect(envelope.result.errors).toEqual([]);
  });

  test("text mode renders a human-readable summary", async () => {
    await provision(storage);
    const writer = new ServerWriter({ storage, currentJsonKey: CURRENT_JSON_KEY });
    await writer.commit({
      op: "I",
      collection: COLL,
      docId: "t-1",
      body: { _id: "t-1", title: "first" },
    });

    const stdout = captureStream(process.stdout);
    let exitCode: number;
    try {
      exitCode = await runInspect([
        `--bucket=file://${root}`,
        `--app=${APP}`,
        `--tenant=${TENANT}`,
        `--table=${COLL}`,
      ]);
    } finally {
      stdout.restore();
    }
    expect(exitCode).toBe(0);
    const text = stdout.captured.join("");
    expect(text).toContain("baerly inspect tickets");
    expect(text).toContain("materialised_rows:   1");
    expect(text).toContain("status:              ok");
  });

  test("flags orphan snapshots in the errors array", async () => {
    await provision(storage);
    // Write a fake snapshot file at the canonical L9 path. current.json
    // still points at `null` (no snapshot), so this is an orphan.
    const orphanKey = `${TABLE_PREFIX}/snapshot/L9/000000000000-000000000000-ghosthash.json`;
    await storage.put(orphanKey, new Uint8Array(0), {
      ifNoneMatch: "*",
      contentType: "application/json",
    });

    const stdout = captureStream(process.stdout);
    let exitCode: number;
    try {
      exitCode = await runInspect([
        `--bucket=file://${root}`,
        `--app=${APP}`,
        `--tenant=${TENANT}`,
        `--table=${COLL}`,
        "--json",
      ]);
    } finally {
      stdout.restore();
    }
    expect(exitCode).toBe(0);
    const envelope = JSON.parse(stdout.captured.join("").trim()) as {
      result: { status: string; errors: string[] };
    };
    expect(envelope.result.status).toBe("error");
    expect(envelope.result.errors.some((e) => e.includes(orphanKey))).toBe(true);
  });

  test("missing current.json surfaces InvalidConfig (exit 1)", async () => {
    const stderr = captureStream(process.stderr);
    let exitCode: number;
    try {
      exitCode = await runInspect([
        `--bucket=file://${root}`,
        `--app=${APP}`,
        `--tenant=${TENANT}`,
        `--table=${COLL}`,
      ]);
    } finally {
      stderr.restore();
    }
    expect(exitCode).toBe(1);
    expect(stderr.captured.join("")).toContain("InvalidConfig");
  });

  test("unknown flag rejected with exit 1", async () => {
    const exitCode = await runInspect([
      `--bucket=file://${root}`,
      `--app=${APP}`,
      `--tenant=${TENANT}`,
      `--table=${COLL}`,
      "--unknown=oops",
    ]);
    expect(exitCode).toBe(1);
  });

  test("dev backend (file://) produces trajectory: null in JSON envelope", async () => {
    await provision(storage);
    const writer = new ServerWriter({ storage, currentJsonKey: CURRENT_JSON_KEY });
    await writer.commit({
      op: "I",
      collection: COLL,
      docId: "t-1",
      body: { _id: "t-1", title: "first" },
    });

    const stdout = captureStream(process.stdout);
    let exitCode: number;
    try {
      exitCode = await runInspect([
        `--bucket=file://${root}`,
        `--app=${APP}`,
        `--tenant=${TENANT}`,
        `--table=${COLL}`,
        "--json",
      ]);
    } finally {
      stdout.restore();
    }
    expect(exitCode).toBe(0);
    const envelope = JSON.parse(stdout.captured.join("").trim()) as {
      result: { trajectory: Trajectory | null };
    };
    expect(envelope.result.trajectory).toBeNull();
  });

  test("--provider=r2 with sufficient data produces a Trajectory in JSON envelope", async () => {
    await provision(storage);
    const writer = new ServerWriter({ storage, currentJsonKey: CURRENT_JSON_KEY });
    for (let i = 0; i < 3; i++) {
      await writer.commit({
        op: "I",
        collection: COLL,
        docId: `t-${i}`,
        body: { _id: `t-${i}`, title: `row ${i}` },
      });
      await new Promise((r) => setTimeout(r, 10));
    }

    const stdout = captureStream(process.stdout);
    let exitCode: number;
    try {
      exitCode = await runInspect([
        `--bucket=file://${root}`,
        `--app=${APP}`,
        `--tenant=${TENANT}`,
        `--table=${COLL}`,
        "--provider=r2",
        "--json",
      ]);
    } finally {
      stdout.restore();
    }
    expect(exitCode).toBe(0);
    const envelope = JSON.parse(stdout.captured.join("").trim()) as {
      result: { trajectory: Trajectory | null };
    };
    expect(envelope.result.trajectory).not.toBeNull();
    expect(envelope.result.trajectory!.provider).toBe("r2");
    expect(envelope.result.trajectory!.classAPerMonth).toBeGreaterThan(0);
    expect(typeof envelope.result.trajectory!.withinFreeTier).toBe("boolean");
  });

  test("--provider=self-hosted produces a Trajectory with null usd", async () => {
    await provision(storage);
    const writer = new ServerWriter({ storage, currentJsonKey: CURRENT_JSON_KEY });
    for (let i = 0; i < 3; i++) {
      await writer.commit({
        op: "I",
        collection: COLL,
        docId: `t-${i}`,
        body: { _id: `t-${i}`, title: `row ${i}` },
      });
      await new Promise((r) => setTimeout(r, 10));
    }

    const stdout = captureStream(process.stdout);
    let exitCode: number;
    try {
      exitCode = await runInspect([
        `--bucket=file://${root}`,
        `--app=${APP}`,
        `--tenant=${TENANT}`,
        `--table=${COLL}`,
        "--provider=self-hosted",
        "--json",
      ]);
    } finally {
      stdout.restore();
    }
    expect(exitCode).toBe(0);
    const envelope = JSON.parse(stdout.captured.join("").trim()) as {
      result: { trajectory: Trajectory | null };
    };
    expect(envelope.result.trajectory).not.toBeNull();
    expect(envelope.result.trajectory!.provider).toBe("self-hosted");
    expect(envelope.result.trajectory!.projectedUsdPerMonth).toBeNull();
    expect(envelope.result.trajectory!.percentOfGraduation).toBeGreaterThanOrEqual(0);
  });

  test("--provider=r2 with <2 log entries produces trajectory: null", async () => {
    await provision(storage);
    const stdout = captureStream(process.stdout);
    let exitCode: number;
    try {
      exitCode = await runInspect([
        `--bucket=file://${root}`,
        `--app=${APP}`,
        `--tenant=${TENANT}`,
        `--table=${COLL}`,
        "--provider=r2",
        "--json",
      ]);
    } finally {
      stdout.restore();
    }
    expect(exitCode).toBe(0);
    const envelope = JSON.parse(stdout.captured.join("").trim()) as {
      result: { trajectory: Trajectory | null };
    };
    expect(envelope.result.trajectory).toBeNull();
  });

  test("--provider=r2 text mode renders a trajectory footer block", async () => {
    await provision(storage);
    const writer = new ServerWriter({ storage, currentJsonKey: CURRENT_JSON_KEY });
    for (let i = 0; i < 3; i++) {
      await writer.commit({
        op: "I",
        collection: COLL,
        docId: `t-${i}`,
        body: { _id: `t-${i}`, title: `row ${i}` },
      });
      await new Promise((r) => setTimeout(r, 10));
    }

    const stdout = captureStream(process.stdout);
    let exitCode: number;
    try {
      exitCode = await runInspect([
        `--bucket=file://${root}`,
        `--app=${APP}`,
        `--tenant=${TENANT}`,
        `--table=${COLL}`,
        "--provider=r2",
      ]);
    } finally {
      stdout.restore();
    }
    expect(exitCode).toBe(0);
    const text = stdout.captured.join("");
    expect(text).toContain("trajectory:");
    expect(text).toContain("writes/min");
    expect(text).toContain("Class A/mo");
  });

  test("estimator failure surfaces in errors[] with status: error", async () => {
    await provision(storage);
    // Write garbage "log entry" bodies that will make estimateWritesPerMin
    // throw InvalidResponse on JSON.parse. Need ≥2 entries because the
    // estimator returns NaN (no throw) when the sample is < 2.
    const logKey0 = `${TABLE_PREFIX}/log/0.json`;
    const logKey1 = `${TABLE_PREFIX}/log/1.json`;
    await storage.put(logKey0, new TextEncoder().encode("not valid json {"), {
      ifNoneMatch: "*",
      contentType: "application/json",
    });
    await storage.put(logKey1, new TextEncoder().encode("also garbage"), {
      ifNoneMatch: "*",
      contentType: "application/json",
    });

    const stdout = captureStream(process.stdout);
    let exitCode: number;
    try {
      exitCode = await runInspect([
        `--bucket=file://${root}`,
        `--app=${APP}`,
        `--tenant=${TENANT}`,
        `--table=${COLL}`,
        "--provider=r2",
        "--json",
      ]);
    } finally {
      stdout.restore();
    }
    expect(exitCode).toBe(0);
    const envelope = JSON.parse(stdout.captured.join("").trim()) as {
      result: { trajectory: Trajectory | null; status: string; errors: string[] };
    };
    expect(envelope.result.trajectory).toBeNull();
    expect(envelope.result.status).toBe("error");
    expect(envelope.result.errors.some((e) => e.includes("InvalidResponse"))).toBe(true);
  });

  test("--provider=aws-s3 produces a paid Trajectory (no free tier)", async () => {
    await provision(storage);
    const writer = new ServerWriter({ storage, currentJsonKey: CURRENT_JSON_KEY });
    for (let i = 0; i < 3; i++) {
      await writer.commit({
        op: "I",
        collection: COLL,
        docId: `t-${i}`,
        body: { _id: `t-${i}`, title: `row ${i}` },
      });
      await new Promise((r) => setTimeout(r, 10));
    }

    const stdout = captureStream(process.stdout);
    let exitCode: number;
    try {
      exitCode = await runInspect([
        `--bucket=file://${root}`,
        `--app=${APP}`,
        `--tenant=${TENANT}`,
        `--table=${COLL}`,
        "--provider=aws-s3",
        "--json",
      ]);
    } finally {
      stdout.restore();
    }
    expect(exitCode).toBe(0);
    const envelope = JSON.parse(stdout.captured.join("").trim()) as {
      result: { trajectory: Trajectory | null };
    };
    expect(envelope.result.trajectory).not.toBeNull();
    expect(envelope.result.trajectory!.provider).toBe("aws-s3");
    expect(envelope.result.trajectory!.withinFreeTier).toBe(false);
    expect(envelope.result.trajectory!.projectedUsdPerMonth).toBeGreaterThan(0);
  });
});
