/* eslint-disable no-underscore-dangle -- `_id` is the locked
   primary-key field on document shapes; this test threads it
   through writer + inspect CLI. */

/**
 * CLI test for `baerly inspect`.
 *
 * Provisions a fresh `LocalFsStorage` collection with N rows, runs
 * `runInspect` programmatically, and asserts the JSON envelope's
 * row count / tail_hint / log_seq_start. A second test injects an
 * orphan snapshot file and asserts `status: "error"` with the
 * orphan path enumerated in `errors`.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { CURRENT_JSON_SCHEMA_VERSION, createCurrentJson, type Storage } from "@baerly/protocol";
import { LocalFsStorage } from "@baerly/dev";
import { Writer } from "@baerly/server/_internal/testing";
import { runInspect } from "./inspect.ts";

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
    writer_fence: { epoch: 0, owner: "inspect-test", claimed_at: "" },
    snapshot_bytes: 0,
    snapshot_rows: 0,
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

  test("reports row count + tail_hint + log_seq_start in JSON envelope", async () => {
    await provision(storage);
    const writer = new Writer({ storage, currentJsonKey: CURRENT_JSON_KEY });
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
        `--collection=${COLL}`,
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
        tail_hint: number;
        log_seq_start: number;
        live_log_tail: number;
        snapshot: string | null;
        snapshot_bytes: number;
        snapshot_rows: number;
        status: string;
        errors: string[];
      };
    };
    expect(envelope.result.command).toBe("inspect");
    expect(envelope.result.currentJsonKey).toBe(CURRENT_JSON_KEY);
    expect(envelope.result.materialised_rows).toBe(2);
    expect(envelope.result.tail_hint).toBe(2);
    expect(envelope.result.log_seq_start).toBe(0);
    expect(envelope.result.live_log_tail).toBe(2);
    expect(envelope.result.snapshot).toBe(null);
    expect(envelope.result.snapshot_bytes).toBe(0);
    expect(envelope.result.snapshot_rows).toBe(0);
    expect(envelope.result.status).toBe("ok");
    expect(envelope.result.errors).toEqual([]);
  });

  test("text mode renders a human-readable summary", async () => {
    await provision(storage);
    const writer = new Writer({ storage, currentJsonKey: CURRENT_JSON_KEY });
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
        `--collection=${COLL}`,
      ]);
    } finally {
      stdout.restore();
    }
    expect(exitCode).toBe(0);
    const text = stdout.captured.join("");
    expect(text).toContain("baerly inspect tickets");
    expect(text).toContain("materialised_rows:   1");
    expect(text).toContain("snapshot_bytes:      0");
    expect(text).toContain("snapshot_rows:       0");
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
        `--collection=${COLL}`,
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
        `--collection=${COLL}`,
      ]);
    } finally {
      stderr.restore();
    }
    expect(exitCode).toBe(1);
    expect(stderr.captured.join("")).toContain("InvalidConfig");
  });

  test("traversal-shaped --collection rejected → InvalidConfig (exit 1)", async () => {
    // A read command must reject a traversal collection segment via the
    // same shared rule, before it builds a `../current.json`-shaped key.
    const stderr = captureStream(process.stderr);
    let exitCode: number;
    try {
      exitCode = await runInspect([
        `--bucket=file://${root}`,
        `--app=${APP}`,
        `--tenant=${TENANT}`,
        `--collection=..`,
      ]);
    } finally {
      stderr.restore();
    }
    expect(exitCode).toBe(1);
    const msg = stderr.captured.join("");
    expect(msg).toContain("InvalidConfig");
    expect(msg).toContain("baerly inspect");
    expect(msg).toContain("collection");
  });

  test("unknown flag rejected with exit 1", async () => {
    const exitCode = await runInspect([
      `--bucket=file://${root}`,
      `--app=${APP}`,
      `--tenant=${TENANT}`,
      `--collection=${COLL}`,
      "--unknown=oops",
    ]);
    expect(exitCode).toBe(1);
  });
});
