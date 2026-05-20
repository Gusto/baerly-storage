/* eslint-disable no-underscore-dangle -- `_id` is the locked
   primary-key field on document shapes; this test threads it
   through writer + dump CLI. */

/**
 * CLI test for `baerly admin dump`.
 *
 * Provisions a fresh `LocalFsStorage` collection with two rows (one
 * with a nested object whose keys are inserted out of order), runs
 * `runDump` with a `createWriteStream` redirected to a temp file, and
 * asserts the output matches a hand-crafted canonical string
 * byte-for-byte.
 */

import { createWriteStream, type WriteStream } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { CURRENT_JSON_SCHEMA_VERSION, createCurrentJson, type Storage } from "@baerly/protocol";
import { LocalFsStorage } from "@baerly/dev";
import { Writer } from "@baerly/server/_internal/testing";
import { runDump, canonicalStringify } from "./dump.ts";

/**
 * Open a write-stream sink and return a `{ stream, finish }` pair.
 * `finish` resolves once the kernel has flushed the file to disk —
 * vitest reads the file synchronously right after, and on the macOS
 * APFS path that read raced a not-yet-flushed `WriteStream` in
 * practice.
 */
const openSink = (path: string): { stream: WriteStream; finish: () => Promise<void> } => {
  const stream = createWriteStream(path);
  const finish = async (): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      stream.once("error", reject);
      stream.end(() => resolve());
    });
  };
  return { stream, finish };
};

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
    writer_fence: { epoch: 0, owner: "dump-test", claimed_at: "" },
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

describe("canonicalStringify", () => {
  test("sorts keys ASCII-lex at every nesting level", () => {
    expect(canonicalStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalStringify({ b: { y: 1, x: 2 }, a: 3 })).toBe('{"a":3,"b":{"x":2,"y":1}}');
  });
  test("rejects non-finite numbers as InvalidResponse", () => {
    expect(() => canonicalStringify(Infinity as unknown as number)).toThrow(/non-finite/);
    expect(() => canonicalStringify(NaN as unknown as number)).toThrow(/non-finite/);
  });
  test("escapes strings per JSON.stringify", () => {
    expect(canonicalStringify({ s: "he\nllo" })).toBe('{"s":"he\\nllo"}');
  });
});

describe("baerly admin dump", () => {
  let root: string;
  let outFile: string;
  let storage: LocalFsStorage;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "baerly-dump-"));
    outFile = join(root, "out.ndjson");
    storage = new LocalFsStorage({ root });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("emits canonical NDJSON byte-for-byte", async () => {
    await provision(storage);
    const writer = new Writer({ storage, currentJsonKey: CURRENT_JSON_KEY });
    // Insert in a deliberately-non-sorted order so the row-order
    // sort (ascending `_id`) is observable.
    await writer.commit({
      op: "I",
      collection: COLL,
      docId: "t-2",
      body: { _id: "t-2", title: "second", meta: { y: 2, x: 1 } },
    });
    await writer.commit({
      op: "I",
      collection: COLL,
      docId: "t-1",
      body: { _id: "t-1", title: "first", status: "open" },
    });

    const sink = openSink(outFile);
    const exitCode = await runDump(
      [
        `--bucket=file://${root}`,
        `--app=${APP}`,
        `--tenant=${TENANT}`,
        `--table=${COLL}`,
      ],
      { streams: { stdout: sink.stream } },
    );
    await sink.finish();
    expect(exitCode).toBe(0);
    const got = await readFile(outFile, "utf8");
    // The canonical wire: keys sorted at every level, rows sorted by
    // ASCII-lex on _id, one trailing newline.
    const expected =
      `{"_id":"t-1","status":"open","title":"first"}\n` +
      `{"_id":"t-2","meta":{"x":1,"y":2},"title":"second"}\n`;
    expect(got).toBe(expected);
  });

  test("empty collection → empty file (no trailing newline)", async () => {
    await provision(storage);
    const sink = openSink(outFile);
    const exitCode = await runDump(
      [
        `--bucket=file://${root}`,
        `--app=${APP}`,
        `--tenant=${TENANT}`,
        `--table=${COLL}`,
      ],
      { streams: { stdout: sink.stream } },
    );
    await sink.finish();
    expect(exitCode).toBe(0);
    const got = await readFile(outFile, "utf8");
    expect(got).toBe("");
  });

  test("missing current.json surfaces InvalidConfig (exit 1)", async () => {
    const stderr = captureStream(process.stderr);
    let exitCode: number;
    try {
      exitCode = await runDump([
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

  test("--json emits the success envelope on stdout", async () => {
    await provision(storage);
    // Empty collection → no NDJSON written to the sink — but we still
    // pass one in so the `--json` envelope (which lands on
    // `process.stdout`) and the NDJSON body (which lands on
    // `streams.stdout`) flow through separate sinks.
    const sink = openSink(outFile);
    const stdout = captureStream(process.stdout);
    let exitCode: number;
    try {
      exitCode = await runDump(
        [
          `--bucket=file://${root}`,
          `--app=${APP}`,
          `--tenant=${TENANT}`,
          `--table=${COLL}`,
          "--json",
        ],
        { streams: { stdout: sink.stream } },
      );
    } finally {
      stdout.restore();
    }
    await sink.finish();
    expect(exitCode).toBe(0);
    const envelope = JSON.parse(stdout.captured.join("").trim()) as {
      result: { command: string; dumped: number; status: string };
    };
    expect(envelope.result.command).toBe("admin.dump");
    expect(envelope.result.status).toBe("ok");
    expect(envelope.result.dumped).toBe(0);
  });

  test("unknown flag rejected with exit 1", async () => {
    const exitCode = await runDump([
      `--bucket=file://${root}`,
      `--app=${APP}`,
      `--tenant=${TENANT}`,
      `--table=${COLL}`,
      "--unknown=oops",
    ]);
    expect(exitCode).toBe(1);
  });
});
