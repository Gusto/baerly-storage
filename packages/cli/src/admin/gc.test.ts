/* eslint-disable no-underscore-dangle -- `_id` is the locked
   primary-key field on document shapes; this test threads it
   through writer + gc CLI. */

/**
 * CLI smoke test for `baerly admin gc`.
 *
 * Seeds a `LocalFsStorage` collection, runs `compact()` directly to
 * advance `log_seq_start` and produce stale-log + orphan-content
 * candidates, then drives `runGc` via the CLI and asserts the
 * envelope reports the per-category mark counts.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { CURRENT_JSON_SCHEMA_VERSION, createCurrentJson, type Storage } from "@baerly/protocol";
import { LocalFsStorage } from "@baerly/dev";
import { ServerWriter } from "@baerly/server/_internal/testing";
import { compact } from "@baerly/server/maintenance";
import { runGc } from "./gc.ts";

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
    writer_fence: { epoch: 0, owner: "gc-cli-test", claimed_at: "" },
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

describe("baerly admin gc — CLI smoke", () => {
  let root: string;
  let storage: LocalFsStorage;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "baerly-gc-"));
    storage = new LocalFsStorage({ root });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("happy path: emits envelope with per-category mark counts", async () => {
    await provision(storage);
    await seedRows(storage, 150);
    // Compact first so log_seq_start advances and prior content blobs
    // become orphans — gives runGc something to mark.
    const cres = await compact(
      { storage, currentJsonKey: CURRENT_JSON_KEY },
      { minEntriesToCompact: 100 },
    );
    expect(cres.written).toBe(true);

    const stdout = captureStream(process.stdout);
    let exitCode: number;
    try {
      exitCode = await runGc([
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
        gc: {
          marked: {
            stale_log: number;
            orphan_snapshot: number;
            orphan_content: number;
          };
          swept: number;
          pendingDepth: number;
        };
      };
    };
    expect(envelope.result.command).toBe("admin.gc");
    expect(envelope.result.status).toBe("ok");
    expect(envelope.result.table).toBe(COLL);
    // Stale log: the compactor advanced log_seq_start, so the folded
    // entries [0, foldEnd) are stale candidates.
    expect(envelope.result.gc.marked.stale_log).toBeGreaterThan(0);
    // The 7-day grace period blocks sweeps on a freshly-marked bucket;
    // the un-swept marks accumulate on pending.json.
    expect(envelope.result.gc.pendingDepth).toBeGreaterThan(0);
  });

  test("--cloudflare-free-tier caps marks per category at 20", async () => {
    await provision(storage);
    // Seed enough rows so the post-compact stale-log set exceeds 20,
    // so the cap is observable.
    await seedRows(storage, 150);
    const cres = await compact(
      { storage, currentJsonKey: CURRENT_JSON_KEY },
      { minEntriesToCompact: 100 },
    );
    expect(cres.written).toBe(true);

    const stdout = captureStream(process.stdout);
    let exitCode: number;
    try {
      exitCode = await runGc([
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
        gc: {
          marked: {
            stale_log: number;
            orphan_snapshot: number;
            orphan_content: number;
          };
        };
      };
    };
    // CF free-tier sets maxMarksPerRun=20 — every category is bounded
    // by that cap.
    expect(envelope.result.gc.marked.stale_log).toBeLessThanOrEqual(20);
    expect(envelope.result.gc.marked.orphan_snapshot).toBeLessThanOrEqual(20);
    expect(envelope.result.gc.marked.orphan_content).toBeLessThanOrEqual(20);
  });

  test("bad bucket URI rejected with exit 1", async () => {
    const stderr = captureStream(process.stderr);
    let exitCode: number;
    try {
      exitCode = await runGc([
        "--bucket=not-a-valid-uri",
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
    await provision(storage);
    const exitCode = await runGc([
      `--bucket=file://${root}`,
      `--app=${APP}`,
      `--tenant=${TENANT}`,
      `--table=${COLL}`,
      "--unknown=oops",
    ]);
    expect(exitCode).toBe(1);
  });
});
