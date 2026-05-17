/* eslint-disable no-underscore-dangle -- `_id` is the locked
   primary-key field on document shapes; this test threads it
   through writer + compact CLI. */

/**
 * CLI smoke test for `baerly admin compact`.
 *
 * Seeds a `LocalFsStorage` collection with enough log entries to
 * trip the NODE_PROFILE's `minEntriesToCompact` (100), runs the
 * command via `runCompact`, asserts the envelope reports
 * `compact.written === true` with the expected `entries_folded`,
 * and exercises `--skip-compact` (GC only) and bad-profile paths.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { CURRENT_JSON_SCHEMA_VERSION, createCurrentJson, type Storage } from "@baerly/protocol";
import { LocalFsStorage } from "@baerly/dev";
import { ServerWriter } from "@baerly/server";
import { runCompact } from "./compact.ts";

const APP = "app";
const TENANT = "tenant";
const COLL = "tickets";
const CURRENT_JSON_KEY = `app/${APP}/tenant/${TENANT}/manifests/${COLL}/current.json`;

const provision = async (storage: Storage): Promise<void> => {
  await createCurrentJson(storage, CURRENT_JSON_KEY, {
    schema_version: CURRENT_JSON_SCHEMA_VERSION,
    snapshot: null,
    next_seq: 0,
    log_seq_start: 0,
    writer_fence: { epoch: 0, owner: "compact-cli-test", claimed_at: "" },
  });
};

const seedRows = async (storage: Storage, count: number): Promise<void> => {
  const writer = new ServerWriter({ storage, currentJsonKey: CURRENT_JSON_KEY });
  for (let i = 0; i < count; i++) {
    await writer.commit({
      op: "I",
      collection: COLL,
      docId: `t-${i}`,
      body: { _id: `t-${i}`, n: i },
    });
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

describe("baerly admin compact — CLI smoke", () => {
  let root: string;
  let storage: LocalFsStorage;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "baerly-compact-"));
    storage = new LocalFsStorage({ root });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("emits envelope with compact.written=true under NODE_PROFILE", async () => {
    await provision(storage);
    await seedRows(storage, 200);

    const stdout = captureStream(process.stdout);
    let exitCode: number;
    try {
      exitCode = await runCompact([
        `--bucket=file://${root}`,
        `--app=${APP}`,
        `--tenant=${TENANT}`,
        `--table=${COLL}`,
        "--profile=node",
        "--json",
      ]);
    } finally {
      stdout.restore();
    }
    expect(exitCode).toBe(0);
    const envelope = JSON.parse(stdout.captured.join("").trim()) as {
      result: {
        command: string;
        status: string;
        compact: { written: boolean; entries_folded: number } | null;
        gc: { marked: { stale_log: number }; swept: number } | null;
      };
    };
    expect(envelope.result.command).toBe("admin.compact");
    expect(envelope.result.status).toBe("ok");
    expect(envelope.result.compact).not.toBeNull();
    if (envelope.result.compact === null) throw new Error("unreachable");
    expect(envelope.result.compact.written).toBe(true);
    expect(envelope.result.compact.entries_folded).toBe(200);
    expect(envelope.result.gc).not.toBeNull();
  });

  test("--skip-compact runs GC only", async () => {
    await provision(storage);
    await seedRows(storage, 50);

    const stdout = captureStream(process.stdout);
    let exitCode: number;
    try {
      exitCode = await runCompact([
        `--bucket=file://${root}`,
        `--app=${APP}`,
        `--tenant=${TENANT}`,
        `--table=${COLL}`,
        "--profile=node",
        "--skip-compact",
        "--json",
      ]);
    } finally {
      stdout.restore();
    }
    expect(exitCode).toBe(0);
    const envelope = JSON.parse(stdout.captured.join("").trim()) as {
      result: { compact: unknown; gc: unknown };
    };
    expect(envelope.result.compact).toBeNull();
    expect(envelope.result.gc).not.toBeNull();
  });

  test("--skip-gc runs compact only", async () => {
    await provision(storage);
    await seedRows(storage, 150);

    const stdout = captureStream(process.stdout);
    let exitCode: number;
    try {
      exitCode = await runCompact([
        `--bucket=file://${root}`,
        `--app=${APP}`,
        `--tenant=${TENANT}`,
        `--table=${COLL}`,
        "--profile=node",
        "--skip-gc",
        "--json",
      ]);
    } finally {
      stdout.restore();
    }
    expect(exitCode).toBe(0);
    const envelope = JSON.parse(stdout.captured.join("").trim()) as {
      result: { compact: unknown; gc: unknown };
    };
    expect(envelope.result.compact).not.toBeNull();
    expect(envelope.result.gc).toBeNull();
  });

  test("bad --profile is rejected with InvalidConfig (exit 1)", async () => {
    await provision(storage);
    const stderr = captureStream(process.stderr);
    let exitCode: number;
    try {
      exitCode = await runCompact([
        `--bucket=file://${root}`,
        `--app=${APP}`,
        `--tenant=${TENANT}`,
        `--table=${COLL}`,
        "--profile=unknown",
      ]);
    } finally {
      stderr.restore();
    }
    expect(exitCode).toBe(1);
    expect(stderr.captured.join("")).toContain("InvalidConfig");
  });

  test("--skip-gc and --skip-compact together rejected with InvalidConfig", async () => {
    await provision(storage);
    const exitCode = await runCompact([
      `--bucket=file://${root}`,
      `--app=${APP}`,
      `--tenant=${TENANT}`,
      `--table=${COLL}`,
      "--profile=node",
      "--skip-gc",
      "--skip-compact",
    ]);
    expect(exitCode).toBe(1);
  });

  test("unknown flag rejected with exit 1", async () => {
    await provision(storage);
    const exitCode = await runCompact([
      `--bucket=file://${root}`,
      `--app=${APP}`,
      `--tenant=${TENANT}`,
      `--table=${COLL}`,
      "--unknown=oops",
    ]);
    expect(exitCode).toBe(1);
  });
});
