/* eslint-disable no-underscore-dangle -- `_id` is the locked
   primary-key field on document shapes; this test threads it
   through writer + rebuild-index CLI. */

/**
 * CLI smoke test for `baerly admin rebuild-index`.
 *
 * Mirrors ticket §6.6: bootstrap a `LocalFsStorage` collection
 * with one stale index key, run the CLI command, confirm
 * `removed: 1` in the JSON envelope, and confirm the orphan key
 * is gone afterwards.
 *
 * Uses `runRebuildIndex` (the test-facing programmatic entry) so
 * the run stays in-process — no citty `runMain` / `process.exit`
 * collision with vitest.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { CURRENT_JSON_SCHEMA_VERSION, createCurrentJson, type Storage } from "@baerly/protocol";
import { LocalFsStorage } from "@baerly/dev";
import { allIndexKeysFor } from "@baerly/server";
import { Writer } from "@baerly/server/_internal/testing";
import { runRebuildIndex } from "./rebuild-index.ts";
import { captureStream } from "../_internal/testing.ts";

const APP = "app";
const TENANT = "tenant";
const COLL = "tickets";

const currentJsonKey = `app/${APP}/tenant/${TENANT}/manifests/${COLL}/current.json`;
const LOG_PREFIX = `app/${APP}/tenant/${TENANT}/manifests/${COLL}`;

const provision = async (storage: Storage): Promise<void> => {
  await createCurrentJson(storage, currentJsonKey, {
    schema_version: CURRENT_JSON_SCHEMA_VERSION,
    snapshot: null,
    tail_hint: 0,
    log_seq_start: 0,
    writer_fence: { epoch: 0, owner: "rebuild-cli-test", claimed_at: "" },
    snapshot_bytes: 0,
    snapshot_rows: 0,
  });
};

const listIndexKeys = async (storage: Storage, indexName: string): Promise<string[]> => {
  const out: string[] = [];
  for await (const entry of storage.list(`${LOG_PREFIX}/index/${indexName}/`)) {
    out.push(entry.key);
  }
  return out.toSorted();
};

describe("baerly admin rebuild-index — orphan index-key reconciliation", () => {
  let root: string;
  let storage: LocalFsStorage;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "baerly-rebuild-index-"));
    storage = new LocalFsStorage({ root });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("reports {removed:1} and prunes the orphan key", async () => {
    // 1. Provision + write one good doc so the index has a real
    //    entry, then inject an orphan key for a doc the log never
    //    references.
    await provision(storage);
    const writer = new Writer({
      storage,
      currentJsonKey,
      options: { indexes: [{ name: "by_status", on: "status" }] },
    });
    await writer.commit({
      op: "I",
      collection: COLL,
      docId: "t-1",
      body: { _id: "t-1", status: "open" },
    });
    const [orphanKey] = allIndexKeysFor(
      LOG_PREFIX,
      [{ name: "by_status", on: "status" }],
      { _id: "ghost", status: "wip" },
      "ghost",
    );
    if (orphanKey === undefined) {
      throw new Error("test setup: failed to build orphan key");
    }
    await storage.put(orphanKey, new Uint8Array(0), {
      ifNoneMatch: "*",
      contentType: "application/json",
    });
    await expect(listIndexKeys(storage, "by_status")).resolves.toHaveLength(2);

    // 2. Capture stdout so we can assert on the JSON envelope.
    const captured: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown): boolean => {
      captured.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    }) as typeof process.stdout.write;

    let exitCode: number;
    try {
      // 3. Run the command. Using file:// URI per the parseBucketUri
      //    contract.
      exitCode = await runRebuildIndex([
        `--bucket=file://${root}`,
        `--app=${APP}`,
        `--tenant=${TENANT}`,
        `--collection=${COLL}`,
        "--index=by_status",
        "--on=status",
        "--json",
      ]);
    } finally {
      process.stdout.write = originalWrite;
    }

    // 4. Assert the envelope and the post-run state.
    expect(exitCode).toBe(0);
    const envelope = JSON.parse(captured.join("").trim()) as {
      result: { added: number; removed: number; kept: number };
    };
    expect(envelope.result.removed).toBe(1);
    expect(envelope.result.added).toBe(0);
    expect(envelope.result.kept).toBe(1);
    await expect(listIndexKeys(storage, "by_status")).resolves.toHaveLength(1);
  });

  test("text mode: silent on success, exit code 0", async () => {
    await provision(storage);
    const writer = new Writer({
      storage,
      currentJsonKey,
      options: { indexes: [{ name: "by_status", on: "status" }] },
    });
    await writer.commit({
      op: "I",
      collection: COLL,
      docId: "t-1",
      body: { _id: "t-1", status: "open" },
    });

    // Healthy index → no-op. Text mode emits nothing on stdout.
    const captured: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown): boolean => {
      captured.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    }) as typeof process.stdout.write;
    let exitCode: number;
    try {
      exitCode = await runRebuildIndex([
        `--bucket=file://${root}`,
        `--app=${APP}`,
        `--tenant=${TENANT}`,
        `--collection=${COLL}`,
        "--index=by_status",
        "--on=status",
      ]);
    } finally {
      process.stdout.write = originalWrite;
    }
    expect(exitCode).toBe(0);
    expect(captured.join("")).toBe("");
  });

  test("missing --on / --config surfaces InvalidConfig (exit 1)", async () => {
    await provision(storage);
    const stderr = captureStream(process.stderr);
    let exitCode: number;
    try {
      exitCode = await runRebuildIndex([
        `--bucket=file://${root}`,
        `--app=${APP}`,
        `--tenant=${TENANT}`,
        `--collection=${COLL}`,
        "--index=by_status",
      ]);
    } finally {
      stderr.restore();
    }
    expect(exitCode).toBe(1);
    expect(stderr.captured.join("")).toContain("is required");
  });

  test("unknown flag rejected with exit 1", async () => {
    await provision(storage);
    const stderr = captureStream(process.stderr);
    let exitCode: number;
    try {
      exitCode = await runRebuildIndex([
        `--bucket=file://${root}`,
        `--app=${APP}`,
        `--tenant=${TENANT}`,
        `--collection=${COLL}`,
        "--index=by_status",
        "--on=status",
        "--unknown=oops",
      ]);
    } finally {
      stderr.restore();
    }
    expect(exitCode).toBe(1);
    expect(stderr.captured.join("")).toContain("unknown flag");
  });
});
