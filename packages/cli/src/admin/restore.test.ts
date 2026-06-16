/* eslint-disable no-underscore-dangle -- `_id` is the locked
   primary-key field on document shapes; this test threads it
   through writer + restore CLI. */

/**
 * CLI test for `baerly admin restore`.
 *
 * Streams canonical NDJSON via the programmatic `streams.stdin` hook
 * on `runRestore`, asserts the post-state `tail_hint` equals the row
 * count, and exercises the `--force` / pre-existing / malformed-line
 * branches.
 */

import { createReadStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { casUpdateCurrentJson, readCurrentJson } from "@baerly/protocol";
import { LocalFsStorage } from "@baerly/dev";
import { runRestore } from "./restore.ts";

const APP = "app";
const TENANT = "tenant";
const COLL = "tickets";
const CURRENT_JSON_KEY = `app/${APP}/tenant/${TENANT}/manifests/${COLL}/current.json`;
const TABLE_PREFIX = `app/${APP}/tenant/${TENANT}/manifests/${COLL}`;

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
    await rm(root, { recursive: true, force: true });
  });

  test("seeds a fresh bucket and lands tail_hint === rowCount", async () => {
    await writeFile(stdinPath, CANONICAL_NDJSON, "utf8");
    const exitCode = await runRestore(
      [`--bucket=file://${root}`, `--app=${APP}`, `--tenant=${TENANT}`, `--collection=${COLL}`],
      { streams: { stdin: createReadStream(stdinPath) } },
    );
    expect(exitCode).toBe(0);
    const head = await readCurrentJson(storage, CURRENT_JSON_KEY);
    expect(head).not.toBeNull();
    expect(head?.json.tail_hint).toBe(2);
  });

  test("re-running without --force on a populated target → Conflict (exit 3)", async () => {
    await writeFile(stdinPath, CANONICAL_NDJSON, "utf8");
    const first = await runRestore(
      [`--bucket=file://${root}`, `--app=${APP}`, `--tenant=${TENANT}`, `--collection=${COLL}`],
      { streams: { stdin: createReadStream(stdinPath) } },
    );
    expect(first).toBe(0);
    const second = await runRestore(
      [`--bucket=file://${root}`, `--app=${APP}`, `--tenant=${TENANT}`, `--collection=${COLL}`],
      { streams: { stdin: createReadStream(stdinPath) } },
    );
    expect(second).toBe(3);
  });

  test("re-running with --force truncates and reseeds", async () => {
    await writeFile(stdinPath, CANONICAL_NDJSON, "utf8");
    const first = await runRestore(
      [`--bucket=file://${root}`, `--app=${APP}`, `--tenant=${TENANT}`, `--collection=${COLL}`],
      { streams: { stdin: createReadStream(stdinPath) } },
    );
    expect(first).toBe(0);

    // Second run: feed three rows so we can confirm the seed was
    // reset (tail_hint = 3, not 5 = 2 + 3).
    const secondNdjson = `{"_id":"u-1","x":1}\n{"_id":"u-2","x":2}\n{"_id":"u-3","x":3}\n`;
    await writeFile(stdinPath, secondNdjson, "utf8");
    const second = await runRestore(
      [
        `--bucket=file://${root}`,
        `--app=${APP}`,
        `--tenant=${TENANT}`,
        `--collection=${COLL}`,
        "--force",
      ],
      { streams: { stdin: createReadStream(stdinPath) } },
    );
    expect(second).toBe(0);
    const head = await readCurrentJson(storage, CURRENT_JSON_KEY);
    // --force advances tail_hint past the old log entries (stale log
    // files are unreferenced and reclaimed on the next GC pass);
    // the second run's 3 inserts add 3 more, giving tail_hint = 5.
    expect(head?.json.tail_hint).toBe(5);
    // log_seq_start tracks the truncation point — every entry from
    // the old generation is past the live tail.
    expect(head?.json.log_seq_start).toBe(2);
    // --force bumps the fence epoch — go from 0 to 1.
    expect(head?.json.writer_fence.epoch).toBeGreaterThanOrEqual(1);
  });

  test("--force chooses old tail from log keys without decoding malformed old entries", async () => {
    await writeFile(stdinPath, CANONICAL_NDJSON, "utf8");
    const first = await runRestore(
      [`--bucket=file://${root}`, `--app=${APP}`, `--tenant=${TENANT}`, `--collection=${COLL}`],
      { streams: { stdin: createReadStream(stdinPath) } },
    );
    expect(first).toBe(0);

    await casUpdateCurrentJson(storage, CURRENT_JSON_KEY, (c) => ({ ...c, tail_hint: 0 }));
    await storage.put(`${TABLE_PREFIX}/log/0.json`, new TextEncoder().encode("{not json"), {
      contentType: "application/json",
    });

    await writeFile(stdinPath, `{"_id":"u-1","x":1}\n`, "utf8");
    const second = await runRestore(
      [
        `--bucket=file://${root}`,
        `--app=${APP}`,
        `--tenant=${TENANT}`,
        `--collection=${COLL}`,
        "--force",
      ],
      { streams: { stdin: createReadStream(stdinPath) } },
    );
    expect(second).toBe(0);
    const head = await readCurrentJson(storage, CURRENT_JSON_KEY);
    expect(head?.json.log_seq_start).toBe(2);
    expect(head?.json.tail_hint).toBe(3);
  });

  test("malformed line → exit 2, no rows committed", async () => {
    // First line is bad (missing _id); confirms the ticket's
    // "no partial-restore state survives when the first line is
    // the failure" semantics.
    await writeFile(stdinPath, `{"missing_id":true}\n`, "utf8");
    const stderr = captureStream(process.stderr);
    let exitCode: number;
    try {
      exitCode = await runRestore(
        [`--bucket=file://${root}`, `--app=${APP}`, `--tenant=${TENANT}`, `--collection=${COLL}`],
        { streams: { stdin: createReadStream(stdinPath) } },
      );
    } finally {
      stderr.restore();
    }
    expect(exitCode).toBe(2);
    const head = await readCurrentJson(storage, CURRENT_JSON_KEY);
    expect(head?.json.tail_hint).toBe(0);
  });

  test("--json emits the success envelope on stdout", async () => {
    await writeFile(stdinPath, CANONICAL_NDJSON, "utf8");
    const stdout = captureStream(process.stdout);
    let exitCode: number;
    try {
      exitCode = await runRestore(
        [
          `--bucket=file://${root}`,
          `--app=${APP}`,
          `--tenant=${TENANT}`,
          `--collection=${COLL}`,
          "--json",
        ],
        { streams: { stdin: createReadStream(stdinPath) } },
      );
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
    const exitCode = await runRestore(
      [`--bucket=file://${root}`, `--app=${APP}`, `--tenant=${TENANT}`, `--collection=${COLL}`],
      { streams: { stdin: createReadStream(stdinPath) } },
    );
    expect(exitCode).toBe(0);
    const head = await readCurrentJson(storage, CURRENT_JSON_KEY);
    expect(head?.json.tail_hint).toBe(2);
  });

  test("traversal-shaped _id rejected by Writer.commit → InvalidConfig (exit 1)", async () => {
    // `restore` only checks `_id` is a non-empty string; the systematic
    // guard lives inside `Writer.commit` (`assertDocId`). A `".."` _id
    // would otherwise write a traversal-shaped key — confirm restore
    // surfaces the rejection (InvalidConfig → exit 1) and commits no rows.
    await writeFile(stdinPath, `{"_id":"..","title":"evil"}\n`, "utf8");
    const stderr = captureStream(process.stderr);
    let exitCode: number;
    try {
      exitCode = await runRestore(
        [`--bucket=file://${root}`, `--app=${APP}`, `--tenant=${TENANT}`, `--collection=${COLL}`],
        { streams: { stdin: createReadStream(stdinPath) } },
      );
    } finally {
      stderr.restore();
    }
    expect(exitCode).toBe(1);
    const head = await readCurrentJson(storage, CURRENT_JSON_KEY);
    expect(head?.json.tail_hint).toBe(0);
  });

  test("control-char _id rejected by Writer.commit → InvalidConfig (exit 1)", async () => {
    // A `_id` carrying a C0 control char (NUL) is rejected by the same
    // `assertDocId` guard inside `commit`. Build the NDJSON with a real
    // control char in the JSON-string body via `String.fromCharCode(0)`
    // — no literal control byte in this source file.
    const badId = `doc${String.fromCharCode(0)}evil`;
    await writeFile(stdinPath, `${JSON.stringify({ _id: badId, title: "evil" })}\n`, "utf8");
    const stderr = captureStream(process.stderr);
    let exitCode: number;
    try {
      exitCode = await runRestore(
        [`--bucket=file://${root}`, `--app=${APP}`, `--tenant=${TENANT}`, `--collection=${COLL}`],
        { streams: { stdin: createReadStream(stdinPath) } },
      );
    } finally {
      stderr.restore();
    }
    expect(exitCode).toBe(1);
    const head = await readCurrentJson(storage, CURRENT_JSON_KEY);
    expect(head?.json.tail_hint).toBe(0);
  });

  test("traversal-shaped --collection rejected at the CLI chokepoint → InvalidConfig (exit 1), writes nothing", async () => {
    // `..` would build a traversal `current.json` key one level up from
    // the manifests prefix. The shared `assertPathSegment` guard must
    // reject it at the CLI chokepoint — fail-fast with an operator-
    // friendly message that names the command + the `collection` role,
    // independent of whatever the backend would do (S3/R2 accept `..`).
    await writeFile(stdinPath, CANONICAL_NDJSON, "utf8");
    const stderr = captureStream(process.stderr);
    let exitCode: number;
    try {
      exitCode = await runRestore(
        [`--bucket=file://${root}`, `--app=${APP}`, `--tenant=${TENANT}`, `--collection=..`],
        { streams: { stdin: createReadStream(stdinPath) } },
      );
    } finally {
      stderr.restore();
    }
    expect(exitCode).toBe(1);
    const msg = stderr.captured.join("");
    expect(msg).toContain("InvalidConfig");
    expect(msg).toContain("baerly admin restore");
    expect(msg).toContain("collection");
    // Nothing committed: the legitimate collection's key never existed.
    const head = await readCurrentJson(storage, CURRENT_JSON_KEY);
    expect(head).toBeNull();
  });

  test("traversal-shaped --app rejected at the CLI chokepoint → InvalidConfig (exit 1)", async () => {
    await writeFile(stdinPath, CANONICAL_NDJSON, "utf8");
    const stderr = captureStream(process.stderr);
    let exitCode: number;
    try {
      exitCode = await runRestore(
        [`--bucket=file://${root}`, `--app=..`, `--tenant=${TENANT}`, `--collection=${COLL}`],
        { streams: { stdin: createReadStream(stdinPath) } },
      );
    } finally {
      stderr.restore();
    }
    expect(exitCode).toBe(1);
    const msg = stderr.captured.join("");
    expect(msg).toContain("InvalidConfig");
    expect(msg).toContain("app");
  });

  test("traversal-shaped --tenant rejected at the CLI chokepoint → InvalidConfig (exit 1)", async () => {
    await writeFile(stdinPath, CANONICAL_NDJSON, "utf8");
    const stderr = captureStream(process.stderr);
    let exitCode: number;
    try {
      exitCode = await runRestore(
        [`--bucket=file://${root}`, `--app=${APP}`, `--tenant=..`, `--collection=${COLL}`],
        { streams: { stdin: createReadStream(stdinPath) } },
      );
    } finally {
      stderr.restore();
    }
    expect(exitCode).toBe(1);
    const msg = stderr.captured.join("");
    expect(msg).toContain("InvalidConfig");
    expect(msg).toContain("tenant");
  });

  test("unknown flag rejected with exit 1", async () => {
    const exitCode = await runRestore([
      `--bucket=file://${root}`,
      `--app=${APP}`,
      `--tenant=${TENANT}`,
      `--collection=${COLL}`,
      "--unknown=oops",
    ]);
    expect(exitCode).toBe(1);
  });
});
