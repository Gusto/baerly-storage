/* eslint-disable no-underscore-dangle -- `_id` is the locked
   primary-key field on document shapes; this test threads it
   through writer + fsck CLI. */

/**
 * CLI test for `baerly admin fsck` — the read-only consistency walk.
 *
 * Each test seeds a `LocalFsStorage` collection and then either
 * injects a corruption (missing log entry, hash-mismatched snapshot,
 * orphan index key) or verifies a clean bucket. The exit-4 path is
 * exercised for each injectable finding; exit-0 is the no-finding
 * baseline.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { CURRENT_JSON_SCHEMA_VERSION, createCurrentJson, type Storage } from "@baerly/protocol";
import { LocalFsStorage } from "@baerly/dev";
import { allIndexKeysFor } from "@baerly/server";
import { Writer } from "@baerly/server/_internal/testing";
import { runFsck } from "./fsck.ts";

const APP = "app";
const TENANT = "tenant";
const COLL = "tickets";
const CURRENT_JSON_KEY = `app/${APP}/tenant/${TENANT}/manifests/${COLL}/current.json`;
const TABLE_PREFIX = `app/${APP}/tenant/${TENANT}/manifests/${COLL}`;

const provision = async (storage: Storage): Promise<void> => {
  await createCurrentJson(storage, CURRENT_JSON_KEY, {
    schema_version: CURRENT_JSON_SCHEMA_VERSION,
    snapshot: null,
    tail_hint: 0,
    log_seq_start: 0,
    writer_fence: { epoch: 0, owner: "fsck-cli-test", claimed_at: "" },
    snapshot_bytes: 0,
    snapshot_rows: 0,
  });
};

const seedRows = async (storage: Storage, count: number): Promise<void> => {
  const writer = new Writer({
    storage,
    currentJsonKey: CURRENT_JSON_KEY,
    options: { indexes: [{ name: "by_status", on: "status" }] },
  });
  for (let i = 0; i < count; i++) {
    await writer.commit({
      op: "I",
      collection: COLL,
      docId: `t-${i}`,
      body: { _id: `t-${i}`, status: i % 2 === 0 ? "open" : "closed" },
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

describe("baerly admin fsck — CLI smoke", () => {
  let root: string;
  let storage: LocalFsStorage;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "baerly-fsck-"));
    storage = new LocalFsStorage({ root });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("clean bucket → exit 0, status ok, no findings", async () => {
    await provision(storage);
    await seedRows(storage, 5);

    const stdout = captureStream(process.stdout);
    let exitCode: number;
    try {
      exitCode = await runFsck([
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
      result: { status: string; findings: unknown[] };
    };
    expect(envelope.result.status).toBe("ok");
    expect(envelope.result.findings).toEqual([]);
  });

  test("hash-mismatched snapshot → exit 4 with finding listing snapshot key", async () => {
    await provision(storage);
    await seedRows(storage, 5);
    // Forge a current.json that points at a snapshot whose body
    // doesn't match the embedded hash. We craft a key with valid
    // shape but wrong-hash content: the body bytes encode an empty
    // snapshot, but the filename hash is for a different (bogus)
    // body.
    const bogusHash = "0".repeat(64);
    const forgedKey = `${TABLE_PREFIX}/snapshot/L9/000000000000-000000000005-${bogusHash}.json`;
    // Write a valid-shape SnapshotBody but with a different hash than
    // the filename claims — the loader recomputes and rejects.
    const body = new TextEncoder().encode(
      JSON.stringify({
        schema_version: 1,
        min_seq: 0,
        max_seq: 5,
        collection: COLL,
        docs: [],
      }),
    );
    await storage.put(forgedKey, body, {
      ifNoneMatch: "*",
      contentType: "application/json",
    });
    // Repoint current.json. Read + CAS so the etag stays valid.
    const { readCurrentJson, casUpdateCurrentJson } = await import("@baerly/protocol");
    const read = await readCurrentJson(storage, CURRENT_JSON_KEY);
    if (read === null) {
      throw new Error("test setup: missing current.json");
    }
    await casUpdateCurrentJson(storage, CURRENT_JSON_KEY, (c) => ({ ...c, snapshot: forgedKey }));

    const stdout = captureStream(process.stdout);
    let exitCode: number;
    try {
      exitCode = await runFsck([
        `--bucket=file://${root}`,
        `--app=${APP}`,
        `--tenant=${TENANT}`,
        `--collection=${COLL}`,
        "--json",
      ]);
    } finally {
      stdout.restore();
    }
    expect(exitCode).toBe(4);
    const envelope = JSON.parse(stdout.captured.join("").trim()) as {
      result: { status: string; findings: { check: string; key?: string }[] };
    };
    expect(envelope.result.status).toBe("findings");
    expect(
      envelope.result.findings.some((f) => f.check === "snapshot" && f.key === forgedKey),
    ).toBe(true);
  });

  test("log hole → exit 4 with finding listing missing seq", async () => {
    await provision(storage);
    await seedRows(storage, 5);
    // Delete one log entry in the middle of the visible range.
    const targetKey = `${TABLE_PREFIX}/log/2.json`;
    await storage.delete(targetKey);

    const stdout = captureStream(process.stdout);
    let exitCode: number;
    try {
      exitCode = await runFsck([
        `--bucket=file://${root}`,
        `--app=${APP}`,
        `--tenant=${TENANT}`,
        `--collection=${COLL}`,
        "--json",
      ]);
    } finally {
      stdout.restore();
    }
    expect(exitCode).toBe(4);
    const envelope = JSON.parse(stdout.captured.join("").trim()) as {
      result: { findings: { check: string; key?: string }[] };
    };
    expect(envelope.result.findings.some((f) => f.check === "log" && f.key === targetKey)).toBe(
      true,
    );
  });

  test("orphan index key with --indexes → exit 4 with drift finding", async () => {
    await provision(storage);
    await seedRows(storage, 3);
    // Inject an orphan index key. Use `allIndexKeysFor` so the
    // physical key matches the writer's encoding.
    const [orphanKey] = allIndexKeysFor(
      TABLE_PREFIX,
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

    // Write a JSON config so --config can resolve the index def.
    const cfgPath = join(root, "baerly.config.json");
    await writeFile(
      cfgPath,
      JSON.stringify({
        collections: { [COLL]: { indexes: [{ name: "by_status", on: "status" }] } },
      }),
      "utf8",
    );

    const stdout = captureStream(process.stdout);
    let exitCode: number;
    try {
      exitCode = await runFsck([
        `--bucket=file://${root}`,
        `--app=${APP}`,
        `--tenant=${TENANT}`,
        `--collection=${COLL}`,
        "--indexes",
        `--config=${cfgPath}`,
        "--json",
      ]);
    } finally {
      stdout.restore();
    }
    expect(exitCode).toBe(4);
    const envelope = JSON.parse(stdout.captured.join("").trim()) as {
      result: {
        mode: string;
        indexes: { name: string; added: number; removed: number; rebuilt: boolean }[];
        findings: { check: string; severity: string }[];
      };
    };
    expect(envelope.result.mode).toBe("indexes");
    const summary = envelope.result.indexes.find((i) => i.name === "by_status");
    expect(summary?.removed).toBeGreaterThanOrEqual(1);
    expect(summary?.rebuilt).toBe(false);
    expect(
      envelope.result.findings.some(
        (f) => f.check === "index.by_status" && f.severity === "warning",
      ),
    ).toBe(true);
  });

  test("orphan index key WITHOUT --indexes → exit 0 (default mode skips index walk)", async () => {
    await provision(storage);
    await seedRows(storage, 3);
    const [orphanKey] = allIndexKeysFor(
      TABLE_PREFIX,
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

    const stdout = captureStream(process.stdout);
    let exitCode: number;
    try {
      exitCode = await runFsck([
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
  });

  test("--indexes --fix rebuilds drifted keys; finding downgrades to info", async () => {
    await provision(storage);
    await seedRows(storage, 3);
    const [orphanKey] = allIndexKeysFor(
      TABLE_PREFIX,
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

    const cfgPath = join(root, "baerly.config.json");
    await writeFile(
      cfgPath,
      JSON.stringify({
        collections: { [COLL]: { indexes: [{ name: "by_status", on: "status" }] } },
      }),
      "utf8",
    );

    const stdout = captureStream(process.stdout);
    let exitCode: number;
    try {
      exitCode = await runFsck([
        `--bucket=file://${root}`,
        `--app=${APP}`,
        `--tenant=${TENANT}`,
        `--collection=${COLL}`,
        "--indexes",
        "--fix",
        `--config=${cfgPath}`,
        "--json",
      ]);
    } finally {
      stdout.restore();
    }
    // `--fix` downgrades drift findings to `info` (since drift was
    // both detected AND fixed in one pass); only `warning` / `finding`
    // severities count toward exit 4, so exit 0.
    expect(exitCode).toBe(0);
    const envelope = JSON.parse(stdout.captured.join("").trim()) as {
      result: {
        mode: string;
        indexes: { name: string; rebuilt: boolean }[];
        findings: { check: string; severity: string }[];
      };
    };
    expect(envelope.result.mode).toBe("indexes-fix");
    expect(envelope.result.indexes.find((i) => i.name === "by_status")?.rebuilt).toBe(true);
    expect(
      envelope.result.findings.some((f) => f.check === "index.by_status" && f.severity === "info"),
    ).toBe(true);
    // Orphan key was deleted by the rebuild.
    await expect(storage.get(orphanKey)).resolves.toBeNull();
  });

  test("--fix without --indexes rejected with InvalidConfig (exit 1)", async () => {
    await provision(storage);
    const stderr = captureStream(process.stderr);
    let exitCode: number;
    try {
      exitCode = await runFsck([
        `--bucket=file://${root}`,
        `--app=${APP}`,
        `--tenant=${TENANT}`,
        `--collection=${COLL}`,
        "--fix",
      ]);
    } finally {
      stderr.restore();
    }
    expect(exitCode).toBe(1);
    expect(stderr.captured.join("")).toContain("InvalidConfig");
  });

  test("--indexes without --config rejected with InvalidConfig (exit 1)", async () => {
    await provision(storage);
    const stderr = captureStream(process.stderr);
    let exitCode: number;
    try {
      exitCode = await runFsck([
        `--bucket=file://${root}`,
        `--app=${APP}`,
        `--tenant=${TENANT}`,
        `--collection=${COLL}`,
        "--indexes",
      ]);
    } finally {
      stderr.restore();
    }
    expect(exitCode).toBe(1);
    expect(stderr.captured.join("")).toContain("InvalidConfig");
  });

  test("missing current.json surfaces InvalidConfig (exit 1)", async () => {
    const exitCode = await runFsck([
      `--bucket=file://${root}`,
      `--app=${APP}`,
      `--tenant=${TENANT}`,
      `--collection=${COLL}`,
    ]);
    expect(exitCode).toBe(1);
  });

  test("unknown flag rejected with exit 1", async () => {
    await provision(storage);
    const exitCode = await runFsck([
      `--bucket=file://${root}`,
      `--app=${APP}`,
      `--tenant=${TENANT}`,
      `--collection=${COLL}`,
      "--unknown=oops",
    ]);
    expect(exitCode).toBe(1);
  });
});
