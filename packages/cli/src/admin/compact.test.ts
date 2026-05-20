/* eslint-disable no-underscore-dangle -- `_id` is the locked
   primary-key field on document shapes; this test threads it
   through writer + compact CLI. */

/**
 * CLI smoke test for `baerly admin compact`.
 *
 * Seeds a `LocalFsStorage` collection with log entries, runs the
 * command via `runCompact`, and asserts the envelope reports a
 * landed compaction. Covers `--cloudflare-free-tier` (caps applied)
 * and `--min-entries` (threshold override).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { CURRENT_JSON_SCHEMA_VERSION, createCurrentJson, type Storage } from "@baerly/protocol";
import { LocalFsStorage } from "@baerly/dev";
import { Writer } from "@baerly/server/_internal/testing";
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
  const writer = new Writer({ storage, currentJsonKey: CURRENT_JSON_KEY });
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

  test("happy path: emits envelope with compact.written=true and no gc arm", async () => {
    await provision(storage);
    // Default `compact()` minEntriesToCompact is 100; seed 200 to clear it.
    await seedRows(storage, 200);

    const stdout = captureStream(process.stdout);
    let exitCode: number;
    try {
      exitCode = await runCompact([
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
        status: string;
        table: string;
        compact: { written: boolean; entries_folded: number };
        gc?: unknown;
      };
    };
    expect(envelope.result.command).toBe("admin.compact");
    expect(envelope.result.status).toBe("ok");
    expect(envelope.result.table).toBe(COLL);
    expect(envelope.result.compact.written).toBe(true);
    expect(envelope.result.compact.entries_folded).toBe(200);
    // The `gc` envelope arm is gone post-split.
    expect(envelope.result.gc).toBeUndefined();
  });

  test("--cloudflare-free-tier caps entries_folded at 20", async () => {
    await provision(storage);
    // Seed past CF free-tier's minEntriesToCompact (50) so compaction
    // runs; the maxEntriesPerRun=20 cap then truncates the fold.
    await seedRows(storage, 100);

    const stdout = captureStream(process.stdout);
    let exitCode: number;
    try {
      exitCode = await runCompact([
        `--bucket=file://${root}`,
        `--app=${APP}`,
        `--tenant=${TENANT}`,
        `--table=${COLL}`,
        "--cloudflare-free-tier",
        "--json",
      ]);
    } finally {
      stdout.restore();
    }
    expect(exitCode).toBe(0);
    const envelope = JSON.parse(stdout.captured.join("").trim()) as {
      result: {
        compact: { written: boolean; entries_folded: number };
      };
    };
    expect(envelope.result.compact.written).toBe(true);
    expect(envelope.result.compact.entries_folded).toBe(20);
  });

  test("--min-entries=N overrides the default threshold (forces compaction)", async () => {
    await provision(storage);
    // 30 rows; below the default minEntriesToCompact (100), so a
    // default compact would be a no-op.
    await seedRows(storage, 30);

    const stdout = captureStream(process.stdout);
    let exitCode: number;
    try {
      exitCode = await runCompact([
        `--bucket=file://${root}`,
        `--app=${APP}`,
        `--tenant=${TENANT}`,
        `--table=${COLL}`,
        "--min-entries=10",
        "--json",
      ]);
    } finally {
      stdout.restore();
    }
    expect(exitCode).toBe(0);
    const envelope = JSON.parse(stdout.captured.join("").trim()) as {
      result: {
        compact: { written: boolean; entries_folded: number };
      };
    };
    expect(envelope.result.compact.written).toBe(true);
    expect(envelope.result.compact.entries_folded).toBe(30);
  });

  test("--min-entries=abc is rejected with InvalidConfig (exit 1)", async () => {
    await provision(storage);
    const stderr = captureStream(process.stderr);
    let exitCode: number;
    try {
      exitCode = await runCompact([
        `--bucket=file://${root}`,
        `--app=${APP}`,
        `--tenant=${TENANT}`,
        `--table=${COLL}`,
        "--min-entries=abc",
      ]);
    } finally {
      stderr.restore();
    }
    expect(exitCode).toBe(1);
    expect(stderr.captured.join("")).toContain("InvalidConfig");
  });

  test("--min-entries=-5 is rejected with InvalidConfig (exit 1)", async () => {
    await provision(storage);
    const stderr = captureStream(process.stderr);
    let exitCode: number;
    try {
      exitCode = await runCompact([
        `--bucket=file://${root}`,
        `--app=${APP}`,
        `--tenant=${TENANT}`,
        `--table=${COLL}`,
        "--min-entries=-5",
      ]);
    } finally {
      stderr.restore();
    }
    expect(exitCode).toBe(1);
    expect(stderr.captured.join("")).toContain("InvalidConfig");
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
