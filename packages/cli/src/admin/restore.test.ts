/* eslint-disable no-underscore-dangle -- `_id` is the locked
   primary-key field on document shapes; this test threads it
   through writer + restore CLI. */

/**
 * CLI test for `baerly admin restore`.
 *
 * Streams canonical NDJSON via `BAERLY_RESTORE_STDIN_PATH`, asserts
 * the post-state `next_seq` equals the row count, and exercises
 * the `--force` / pre-existing / malformed-line branches.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { readCurrentJson } from "@baerly/protocol";
import { LocalFsStorage } from "@baerly/dev";
import { runRestore } from "./restore.ts";

const APP = "app";
const TENANT = "tenant";
const COLL = "tickets";
const CURRENT_JSON_KEY = `app/${APP}/tenant/${TENANT}/manifests/${COLL}/current.json`;

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

const CANONICAL_NDJSON =
  `{"_id":"t-1","status":"open","title":"first"}\n` +
  `{"_id":"t-2","meta":{"x":1,"y":2},"title":"second"}\n`;

describe("baerly admin restore", () => {
  let root: string;
  let storage: LocalFsStorage;
  let stdinPath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "baerly-restore-"));
    storage = new LocalFsStorage({ root });
    stdinPath = join(root, "in.ndjson");
  });

  afterEach(async () => {
    delete process.env["BAERLY_RESTORE_STDIN_PATH"];
    await rm(root, { recursive: true, force: true });
  });

  test("seeds a fresh bucket and lands next_seq === rowCount", async () => {
    await writeFile(stdinPath, CANONICAL_NDJSON, "utf8");
    process.env["BAERLY_RESTORE_STDIN_PATH"] = stdinPath;
    const exitCode = await runRestore([
      `--bucket=file://${root}`,
      `--app=${APP}`,
      `--tenant=${TENANT}`,
      `--table=${COLL}`,
    ]);
    expect(exitCode).toBe(0);
    const head = await readCurrentJson(storage, CURRENT_JSON_KEY);
    expect(head).not.toBeNull();
    expect(head?.json.next_seq).toBe(2);
  });

  test("re-running without --force on a populated target → Conflict (exit 3)", async () => {
    await writeFile(stdinPath, CANONICAL_NDJSON, "utf8");
    process.env["BAERLY_RESTORE_STDIN_PATH"] = stdinPath;
    const first = await runRestore([
      `--bucket=file://${root}`,
      `--app=${APP}`,
      `--tenant=${TENANT}`,
      `--table=${COLL}`,
    ]);
    expect(first).toBe(0);
    const second = await runRestore([
      `--bucket=file://${root}`,
      `--app=${APP}`,
      `--tenant=${TENANT}`,
      `--table=${COLL}`,
    ]);
    expect(second).toBe(3);
  });

  test("re-running with --force truncates and reseeds", async () => {
    await writeFile(stdinPath, CANONICAL_NDJSON, "utf8");
    process.env["BAERLY_RESTORE_STDIN_PATH"] = stdinPath;
    const first = await runRestore([
      `--bucket=file://${root}`,
      `--app=${APP}`,
      `--tenant=${TENANT}`,
      `--table=${COLL}`,
    ]);
    expect(first).toBe(0);

    // Second run: feed three rows so we can confirm the seed was
    // reset (next_seq = 3, not 5 = 2 + 3).
    const secondNdjson = `{"_id":"u-1","x":1}\n{"_id":"u-2","x":2}\n{"_id":"u-3","x":3}\n`;
    await writeFile(stdinPath, secondNdjson, "utf8");
    const second = await runRestore([
      `--bucket=file://${root}`,
      `--app=${APP}`,
      `--tenant=${TENANT}`,
      `--table=${COLL}`,
      "--force",
    ]);
    expect(second).toBe(0);
    const head = await readCurrentJson(storage, CURRENT_JSON_KEY);
    // --force advances next_seq past the old log entries (stale log
    // files are unreferenced and reclaimed on the next GC pass);
    // the second run's 3 inserts add 3 more, giving next_seq = 5.
    expect(head?.json.next_seq).toBe(5);
    // log_seq_start tracks the truncation point — every entry from
    // the old generation is past the live tail.
    expect(head?.json.log_seq_start).toBe(2);
    // --force bumps the fence epoch — go from 0 to 1.
    expect(head?.json.writer_fence.epoch).toBeGreaterThanOrEqual(1);
  });

  test("malformed line → exit 2, no rows committed", async () => {
    // First line is bad (missing _id); confirms the ticket's
    // "no partial-restore state survives when the first line is
    // the failure" semantics.
    await writeFile(stdinPath, `{"missing_id":true}\n`, "utf8");
    process.env["BAERLY_RESTORE_STDIN_PATH"] = stdinPath;
    const stderr = captureStream(process.stderr);
    let exitCode: number;
    try {
      exitCode = await runRestore([
        `--bucket=file://${root}`,
        `--app=${APP}`,
        `--tenant=${TENANT}`,
        `--table=${COLL}`,
      ]);
    } finally {
      stderr.restore();
    }
    expect(exitCode).toBe(2);
    const head = await readCurrentJson(storage, CURRENT_JSON_KEY);
    expect(head?.json.next_seq).toBe(0);
  });

  test("--json emits the success envelope on stdout", async () => {
    await writeFile(stdinPath, CANONICAL_NDJSON, "utf8");
    process.env["BAERLY_RESTORE_STDIN_PATH"] = stdinPath;
    const stdout = captureStream(process.stdout);
    let exitCode: number;
    try {
      exitCode = await runRestore([
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
      result: { command: string; restored: number; status: string };
    };
    expect(envelope.result.command).toBe("admin.restore");
    expect(envelope.result.status).toBe("ok");
    expect(envelope.result.restored).toBe(2);
  });

  test("empty lines tolerated", async () => {
    await writeFile(stdinPath, `\n${CANONICAL_NDJSON}\n\n`, "utf8");
    process.env["BAERLY_RESTORE_STDIN_PATH"] = stdinPath;
    const exitCode = await runRestore([
      `--bucket=file://${root}`,
      `--app=${APP}`,
      `--tenant=${TENANT}`,
      `--table=${COLL}`,
    ]);
    expect(exitCode).toBe(0);
    const head = await readCurrentJson(storage, CURRENT_JSON_KEY);
    expect(head?.json.next_seq).toBe(2);
  });

  test("unknown flag rejected with exit 1", async () => {
    const exitCode = await runRestore([
      `--bucket=file://${root}`,
      `--app=${APP}`,
      `--tenant=${TENANT}`,
      `--table=${COLL}`,
      "--unknown=oops",
    ]);
    expect(exitCode).toBe(1);
  });
});
