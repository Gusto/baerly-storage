/* eslint-disable no-underscore-dangle -- `_id` is the locked
   primary-key field on document shapes; this test threads it
   through writer + export CLI. */

/**
 * CLI smoke test for `baerly export`.
 *
 * Each test seeds a `LocalFsStorage` collection through `Writer`,
 * runs `runExport(...)` with the target arguments, and verifies the
 * emitted SQL / sidecar plan / envelope. The four key paths covered:
 *
 *   - Happy path: SQL begins with `CREATE TABLE`, contains every
 *     `INSERT INTO`, sidecar JSON parses to an `ExportPlan` whose
 *     `columns` array matches the in-memory plan.
 *   - `--no-sidecar`: sidecar file is NOT emitted.
 *   - `--where='{"status":"open"}'`: emitted INSERTs are filtered.
 *   - `--where-comment="from spread"`: comment surfaces above the
 *     INSERT lines.
 *   - Bad `--where` JSON / bad `--target` / missing args → exit 1.
 */

import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { CURRENT_JSON_SCHEMA_VERSION, createCurrentJson, type Storage } from "@baerly/protocol";
import { LocalFsStorage } from "@baerly/dev";
import { Writer } from "@baerly/server/_internal/testing";
import { runExport } from "./export.ts";

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
    writer_fence: { epoch: 0, owner: "export-cli-test", claimed_at: "" },
  });
};

const seedRows = async (storage: Storage): Promise<void> => {
  const writer = new Writer({ storage, currentJsonKey: CURRENT_JSON_KEY });
  await writer.commit({
    op: "I",
    collection: COLL,
    docId: "t-1",
    body: { _id: "t-1", status: "open", title: "first" },
  });
  await writer.commit({
    op: "I",
    collection: COLL,
    docId: "t-2",
    body: { _id: "t-2", status: "closed", title: "second" },
  });
  await writer.commit({
    op: "I",
    collection: COLL,
    docId: "t-3",
    body: { _id: "t-3", status: "open", title: "third" },
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

describe("baerly export — CLI smoke", () => {
  let root: string;
  let outFile: string;
  let storage: LocalFsStorage;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "baerly-export-"));
    outFile = join(root, "out.sql");
    storage = new LocalFsStorage({ root });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("emits CREATE TABLE + INSERT rows in _id-sorted order", async () => {
    await provision(storage);
    await seedRows(storage);
    const exitCode = await runExport([
      `--bucket=file://${root}`,
      `--app=${APP}`,
      `--tenant=${TENANT}`,
      `--table=${COLL}`,
      "--target=sqlite",
      `--output=${outFile}`,
    ]);
    expect(exitCode).toBe(0);

    const got = await readFile(outFile, "utf8");
    expect(got).toContain(`CREATE TABLE "tickets" (`);
    // Three rows, in ASCII-lex _id order — t-1, t-2, t-3.
    const lines = got.split("\n").filter((line) => line.startsWith("INSERT INTO"));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain(`'t-1'`);
    expect(lines[1]).toContain(`'t-2'`);
    expect(lines[2]).toContain(`'t-3'`);

    // Sidecar plan parses back into the same column set.
    const sidecar = await readFile(`${outFile}.plan.json`, "utf8");
    const parsed = JSON.parse(sidecar) as { target: string; columns: { source: string }[] };
    expect(parsed.target).toBe("sqlite");
    expect(parsed.columns.map((c) => c.source).toSorted()).toEqual(
      ["_id", "status", "title"].toSorted(),
    );
  });

  test("--no-sidecar skips the sidecar plan emit", async () => {
    await provision(storage);
    await seedRows(storage);
    const exitCode = await runExport([
      `--bucket=file://${root}`,
      `--app=${APP}`,
      `--tenant=${TENANT}`,
      `--table=${COLL}`,
      "--target=sqlite",
      `--output=${outFile}`,
      "--no-sidecar",
    ]);
    expect(exitCode).toBe(0);
    await expect(access(`${outFile}.plan.json`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test('--where=<wire predicate> filters the INSERTs', async () => {
    await provision(storage);
    await seedRows(storage);
    const stdout = captureStream(process.stdout);
    let exitCode: number;
    try {
      exitCode = await runExport([
        `--bucket=file://${root}`,
        `--app=${APP}`,
        `--tenant=${TENANT}`,
        `--table=${COLL}`,
        "--target=sqlite",
        `--output=${outFile}`,
        `--where={"clauses":[{"op":"eq","field":"status","value":"open"}]}`,
        "--json",
      ]);
    } finally {
      stdout.restore();
    }
    expect(exitCode).toBe(0);
    const got = await readFile(outFile, "utf8");
    const lines = got.split("\n").filter((line) => line.startsWith("INSERT INTO"));
    // Only t-1 and t-3 are status=open.
    expect(lines).toHaveLength(2);
    expect(got).toContain(`'t-1'`);
    expect(got).toContain(`'t-3'`);
    expect(got).not.toContain(`'t-2'`);
    expect(got).toContain(`-- WHERE clause for review:`);

    const envelope = JSON.parse(stdout.captured.join("").trim()) as {
      result: { rows: number; hints: unknown[] };
    };
    expect(envelope.result.rows).toBe(2);
  });

  test("--where-comment surfaces operator hint above the INSERTs", async () => {
    await provision(storage);
    await seedRows(storage);
    const exitCode = await runExport([
      `--bucket=file://${root}`,
      `--app=${APP}`,
      `--tenant=${TENANT}`,
      `--table=${COLL}`,
      "--target=sqlite",
      `--output=${outFile}`,
      `--where={"clauses":[{"op":"eq","field":"status","value":"open"}]}`,
      "--where-comment=from spread",
    ]);
    expect(exitCode).toBe(0);
    const got = await readFile(outFile, "utf8");
    expect(got).toContain(`-- TODO(baerly export): caller-flagged dynamic predicate: from spread`);
  });

  test("bad --where JSON → InvalidConfig (exit 1)", async () => {
    await provision(storage);
    await seedRows(storage);
    const stderr = captureStream(process.stderr);
    let exitCode: number;
    try {
      exitCode = await runExport([
        `--bucket=file://${root}`,
        `--app=${APP}`,
        `--tenant=${TENANT}`,
        `--table=${COLL}`,
        "--target=sqlite",
        `--output=${outFile}`,
        "--where={not-json}",
      ]);
    } finally {
      stderr.restore();
    }
    expect(exitCode).toBe(1);
    expect(stderr.captured.join("")).toContain("InvalidConfig");
  });

  test("bad --target → InvalidConfig (exit 1)", async () => {
    await provision(storage);
    await seedRows(storage);
    const exitCode = await runExport([
      `--bucket=file://${root}`,
      `--app=${APP}`,
      `--tenant=${TENANT}`,
      `--table=${COLL}`,
      "--target=oracle",
      `--output=${outFile}`,
    ]);
    expect(exitCode).toBe(1);
  });

  test("missing current.json → InvalidConfig (exit 1)", async () => {
    const exitCode = await runExport([
      `--bucket=file://${root}`,
      `--app=${APP}`,
      `--tenant=${TENANT}`,
      `--table=${COLL}`,
      "--target=sqlite",
      `--output=${outFile}`,
    ]);
    expect(exitCode).toBe(1);
  });

  test("default --output writes SQL to stdout", async () => {
    await provision(storage);
    await seedRows(storage);
    const stdout = captureStream(process.stdout);
    let exitCode: number;
    try {
      exitCode = await runExport([
        `--bucket=file://${root}`,
        `--app=${APP}`,
        `--tenant=${TENANT}`,
        `--table=${COLL}`,
        "--target=sqlite",
      ]);
    } finally {
      stdout.restore();
    }
    expect(exitCode).toBe(0);
    const out = stdout.captured.join("");
    expect(out).toContain(`CREATE TABLE "tickets" (`);
    expect(out).toContain(`INSERT INTO "tickets"`);
  });

  test("unknown flag rejected with exit 1", async () => {
    await provision(storage);
    const exitCode = await runExport([
      `--bucket=file://${root}`,
      `--app=${APP}`,
      `--tenant=${TENANT}`,
      `--table=${COLL}`,
      "--target=sqlite",
      "--unknown=oops",
    ]);
    expect(exitCode).toBe(1);
  });
});
