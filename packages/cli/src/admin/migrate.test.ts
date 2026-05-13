/* eslint-disable no-underscore-dangle -- `_id` is the locked
   primary-key field on document shapes; this test threads it
   through writer + migrate CLI. */

/**
 * CLI smoke test for `baerly admin migrate`.
 *
 * Seeds a `LocalFsStorage` collection, writes an operator-supplied
 * transform module to a temp dir, runs `runMigrate(...)`, and
 * verifies the resulting envelope reports the expected row counts.
 * Also exercises the InvalidConfig paths: missing default export,
 * `.ts` transform path, missing transform file.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  CURRENT_JSON_SCHEMA_VERSION,
  createCurrentJson,
  readCurrentJson,
  type Storage,
} from "@baerly/protocol";
import { LocalFsStorage } from "@baerly/dev";
import { ServerWriter } from "@baerly/server";
import { runMigrate } from "./migrate.ts";

const APP = "app";
const TENANT = "tenant";
const COLL = "tickets";
const CURRENT_JSON_KEY = `app/${APP}/tenant/${TENANT}/manifests/${COLL}/current.json`;

const provision = async (storage: Storage): Promise<void> => {
  await createCurrentJson(storage, CURRENT_JSON_KEY, {
    schema_version: CURRENT_JSON_SCHEMA_VERSION,
    snapshot: null,
    next_seq: 0,
    writer_fence: { epoch: 0, owner: "migrate-cli-test", claimed_at: "" },
  });
};

const seedRows = async (storage: Storage, count: number): Promise<void> => {
  const writer = new ServerWriter({ storage, currentJsonKey: CURRENT_JSON_KEY });
  for (let i = 0; i < count; i++) {
    await writer.commit({
      op: "I",
      collection: COLL,
      docId: `t-${i}`,
      body: { _id: `t-${i}`, n: i, version: 1 },
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

describe("baerly admin migrate — CLI smoke", () => {
  let root: string;
  let storage: LocalFsStorage;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "baerly-migrate-"));
    storage = new LocalFsStorage({ root });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("bumps a field on every row, envelope reports output_rows", async () => {
    await provision(storage);
    await seedRows(storage, 7);
    const transformPath = join(root, "transform.mjs");
    await writeFile(transformPath, `export default (row) => ({ ...row, version: 2 });\n`, "utf8");

    const stdout = captureStream(process.stdout);
    let exitCode: number;
    try {
      exitCode = await runMigrate([
        `--bucket=file://${root}`,
        `--app=${APP}`,
        `--tenant=${TENANT}`,
        `--table=${COLL}`,
        `--transform=${transformPath}`,
        "--target-version=1",
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
        input_rows: number;
        output_rows: number;
        no_op: boolean;
        new_snapshot_key: string | null;
      };
    };
    expect(envelope.result.command).toBe("admin.migrate");
    expect(envelope.result.status).toBe("ok");
    expect(envelope.result.input_rows).toBe(7);
    expect(envelope.result.output_rows).toBe(7);
    expect(envelope.result.no_op).toBe(false);
    expect(envelope.result.new_snapshot_key).not.toBeNull();

    const read = await readCurrentJson(storage, CURRENT_JSON_KEY);
    if (read === null) throw new Error("unreachable");
    expect(read.json.migrated_to).toBe(1);
  });

  test("transform returning null deletes half the rows", async () => {
    await provision(storage);
    await seedRows(storage, 10);
    const transformPath = join(root, "halve.mjs");
    await writeFile(
      transformPath,
      `export default (row) => (row.n % 2 === 0 ? row : null);\n`,
      "utf8",
    );

    const stdout = captureStream(process.stdout);
    let exitCode: number;
    try {
      exitCode = await runMigrate([
        `--bucket=file://${root}`,
        `--app=${APP}`,
        `--tenant=${TENANT}`,
        `--table=${COLL}`,
        `--transform=${transformPath}`,
        "--target-version=2",
        "--json",
      ]);
    } finally {
      stdout.restore();
    }
    expect(exitCode).toBe(0);
    const envelope = JSON.parse(stdout.captured.join("").trim()) as {
      result: { input_rows: number; output_rows: number };
    };
    expect(envelope.result.input_rows).toBe(10);
    expect(envelope.result.output_rows).toBe(5);
  });

  test("re-run with same target-version short-circuits (no_op=true)", async () => {
    await provision(storage);
    await seedRows(storage, 3);
    const transformPath = join(root, "noop.mjs");
    await writeFile(transformPath, `export default (row) => row;\n`, "utf8");

    expect(
      await runMigrate([
        `--bucket=file://${root}`,
        `--app=${APP}`,
        `--tenant=${TENANT}`,
        `--table=${COLL}`,
        `--transform=${transformPath}`,
        "--target-version=1",
        "--json",
      ]),
    ).toBe(0);

    const stdout = captureStream(process.stdout);
    let exitCode: number;
    try {
      exitCode = await runMigrate([
        `--bucket=file://${root}`,
        `--app=${APP}`,
        `--tenant=${TENANT}`,
        `--table=${COLL}`,
        `--transform=${transformPath}`,
        "--target-version=1",
        "--json",
      ]);
    } finally {
      stdout.restore();
    }
    expect(exitCode).toBe(0);
    const envelope = JSON.parse(stdout.captured.join("").trim()) as {
      result: { no_op: boolean };
    };
    expect(envelope.result.no_op).toBe(true);
  });

  test("missing transform path → InvalidConfig (exit 1)", async () => {
    await provision(storage);
    const stderr = captureStream(process.stderr);
    let exitCode: number;
    try {
      exitCode = await runMigrate([
        `--bucket=file://${root}`,
        `--app=${APP}`,
        `--tenant=${TENANT}`,
        `--table=${COLL}`,
        `--transform=${join(root, "does-not-exist.mjs")}`,
        "--target-version=1",
      ]);
    } finally {
      stderr.restore();
    }
    expect(exitCode).toBe(1);
    expect(stderr.captured.join("")).toContain("InvalidConfig");
  });

  test("transform with no default export → InvalidConfig (exit 1)", async () => {
    await provision(storage);
    const transformPath = join(root, "no-default.mjs");
    await writeFile(transformPath, `export const notDefault = (r) => r;\n`, "utf8");

    const exitCode = await runMigrate([
      `--bucket=file://${root}`,
      `--app=${APP}`,
      `--tenant=${TENANT}`,
      `--table=${COLL}`,
      `--transform=${transformPath}`,
      "--target-version=1",
    ]);
    expect(exitCode).toBe(1);
  });

  test(".ts transform path rejected with InvalidConfig", async () => {
    await provision(storage);
    const exitCode = await runMigrate([
      `--bucket=file://${root}`,
      `--app=${APP}`,
      `--tenant=${TENANT}`,
      `--table=${COLL}`,
      `--transform=${join(root, "transform.ts")}`,
      "--target-version=1",
    ]);
    expect(exitCode).toBe(1);
  });

  test("non-integer --target-version rejected with InvalidConfig", async () => {
    await provision(storage);
    const transformPath = join(root, "id.mjs");
    await writeFile(transformPath, `export default (r) => r;\n`, "utf8");
    const exitCode = await runMigrate([
      `--bucket=file://${root}`,
      `--app=${APP}`,
      `--tenant=${TENANT}`,
      `--table=${COLL}`,
      `--transform=${transformPath}`,
      "--target-version=abc",
    ]);
    expect(exitCode).toBe(1);
  });

  test("unknown flag rejected with exit 1", async () => {
    await provision(storage);
    const transformPath = join(root, "id.mjs");
    await writeFile(transformPath, `export default (r) => r;\n`, "utf8");
    const exitCode = await runMigrate([
      `--bucket=file://${root}`,
      `--app=${APP}`,
      `--tenant=${TENANT}`,
      `--table=${COLL}`,
      `--transform=${transformPath}`,
      "--target-version=1",
      "--unknown=oops",
    ]);
    expect(exitCode).toBe(1);
  });
});
