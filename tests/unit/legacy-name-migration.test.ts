/* eslint-disable no-underscore-dangle -- `_id` is the locked primary-key field. */
/**
 * Legacy non-NFC app / tenant / collection names: the SDK refuses them,
 * the read-only operator CLI still reads and exports them, the writing
 * CLI verbs refuse them as targets, and `admin dump` + `admin restore`
 * migrate the rows to an NFC name. `admin fsck` and `admin dump` flag
 * what a migration has to handle, including rows whose `_id`s are
 * canonically equivalent (legacy twins).
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { describe, expect, test } from "vitest";
import {
  createCurrentJson,
  getOrCreateMemoryStorageForBucket,
  type Storage,
} from "@baerly/protocol";
import { Db } from "@baerly/server";
import { captureStream } from "../../packages/cli/src/_internal/testing.ts";
import { runDump } from "../../packages/cli/src/admin/dump.ts";
import { runFsck } from "../../packages/cli/src/admin/fsck.ts";
import { runRebuildIndex } from "../../packages/cli/src/admin/rebuild-index.ts";
import { runRestore } from "../../packages/cli/src/admin/restore.ts";
import { runInspect } from "../../packages/cli/src/inspect.ts";
import { logStateCurrentJson, seedLogEntry } from "../fixtures/log-state.ts";

const NFC = "café";
const NFD = "café"; // canonically equivalent to NFC

let bucketSeq = 0;
const freshBucket = (): { uri: string; storage: Storage } => {
  const name = `legacy-names-${process.pid}-${bucketSeq++}`;
  return { uri: `memory://${name}`, storage: getOrCreateMemoryStorageForBucket(name) };
};

/** Seed collection bytes the way a release without the NFC name rule wrote them. */
const seedCollection = async (
  storage: Storage,
  names: { app: string; tenant: string; collection: string },
  rows: readonly { _id: string; kind: string }[],
): Promise<void> => {
  const prefix = `app/${names.app}/tenant/${names.tenant}/manifests/${names.collection}`;
  await createCurrentJson(
    storage,
    `${prefix}/current.json`,
    logStateCurrentJson({ tail_hint: rows.length }),
  );
  for (const [seq, row] of rows.entries()) {
    await seedLogEntry(storage, prefix, seq, {
      collection: names.collection,
      doc_id: row._id,
      after: row,
    });
  }
};

const sink = (): { stream: Writable; text: () => string } => {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return { stream, text: () => chunks.join("") };
};

/** Run a CLI entry with stdout + stderr captured. */
const captured = async (
  run: () => Promise<number>,
): Promise<{ code: number; stdout: string; stderr: string }> => {
  const out = captureStream(process.stdout);
  const err = captureStream(process.stderr);
  try {
    const code = await run();
    return { code, stdout: out.captured.join(""), stderr: err.captured.join("") };
  } finally {
    out.restore();
    err.restore();
  }
};

const ROWS = [
  { _id: "a", kind: "x" },
  { _id: "b", kind: "y" },
];

describe("a collection stored under a legacy non-NFC name", () => {
  test("the SDK refuses the name; the read-only CLI verbs still read it", async () => {
    const { uri, storage } = freshBucket();
    const names = { app: "app", tenant: "tenant", collection: NFD };
    await seedCollection(storage, names, ROWS);
    const flags = [`--bucket=${uri}`, "--app=app", "--tenant=tenant", `--collection=${NFD}`];

    const db = Db.create({ storage, app: "app", tenant: "tenant" });
    expect(() => db.collection(NFD)).toThrow(expect.objectContaining({ code: "InvalidConfig" }));

    const out = sink();
    await expect(runDump(flags, { streams: { stdout: out.stream } })).resolves.toBe(0);
    expect(
      out
        .text()
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as unknown),
    ).toEqual(ROWS);

    await expect(captured(() => runInspect(flags))).resolves.toMatchObject({ code: 0 });
  });

  test("fsck flags every non-NFC name as a migration finding", async () => {
    const { uri, storage } = freshBucket();
    const names = { app: NFD, tenant: "tenant", collection: NFD };
    await seedCollection(storage, names, ROWS);
    const res = await captured(() =>
      runFsck([
        `--bucket=${uri}`,
        `--app=${NFD}`,
        "--tenant=tenant",
        `--collection=${NFD}`,
        "--json",
      ]),
    );
    expect(res.code).toBe(4);
    const envelope = JSON.parse(res.stdout.trim()) as {
      result: { findings: { severity: string; check: string }[] };
    };
    const nameFindings = envelope.result.findings.filter((f) => f.check === "names");
    expect(nameFindings).toHaveLength(2);
    expect(nameFindings.every((f) => f.severity === "warning")).toBe(true);
  });

  test("fsck on NFC names reports no name finding", async () => {
    const { uri, storage } = freshBucket();
    await seedCollection(storage, { app: "app", tenant: "tenant", collection: NFC }, ROWS);
    const res = await captured(() =>
      runFsck([`--bucket=${uri}`, "--app=app", "--tenant=tenant", `--collection=${NFC}`]),
    );
    expect(res.code).toBe(0);
  });

  test("dump + restore migrates the rows to a fresh NFC name; non-NFC targets are refused", async () => {
    const { uri, storage } = freshBucket();
    await seedCollection(storage, { app: "app", tenant: "tenant", collection: NFD }, ROWS);
    const out = sink();
    await expect(
      runDump([`--bucket=${uri}`, "--app=app", "--tenant=tenant", `--collection=${NFD}`], {
        streams: { stdout: out.stream },
      }),
    ).resolves.toBe(0);
    const ndjson = out.text();

    const restore = (target: { app?: string; collection: string }): Promise<number> =>
      captured(() =>
        runRestore(
          [
            `--bucket=${uri}`,
            `--app=${target.app ?? "app"}`,
            "--tenant=tenant",
            `--collection=${target.collection}`,
          ],
          { streams: { stdin: Readable.from([ndjson]) } },
        ),
      ).then((r) => r.code);

    // A non-NFC target name is refused before any write.
    await expect(restore({ collection: "v2-café" })).resolves.toBe(1);
    await expect(restore({ app: NFD, collection: "v2" })).resolves.toBe(1);
    await expect(
      storage.get("app/app/tenant/tenant/manifests/v2-café/current.json"),
    ).resolves.toBeNull();

    // The migration target is NFC and not canonically equivalent to the
    // legacy name.
    const target = `${NFC}-v2`;
    await expect(restore({ collection: target })).resolves.toBe(0);
    const rows = Db.create({ storage, app: "app", tenant: "tenant" }).collection(target);
    const restored = await rows.where({}).all();
    expect(restored).toHaveLength(ROWS.length);
    expect(restored).toEqual(expect.arrayContaining(ROWS));
  });

  test("rebuild-index and fsck --indexes --fix refuse a non-NFC name", async () => {
    const { uri, storage } = freshBucket();
    await seedCollection(storage, { app: "app", tenant: "tenant", collection: NFD }, ROWS);
    const flags = [`--bucket=${uri}`, "--app=app", "--tenant=tenant", `--collection=${NFD}`];
    const rebuilt = await captured(() =>
      runRebuildIndex([...flags, "--index=by_kind", "--on=kind"]),
    );
    expect(rebuilt.code).toBe(1);

    const dir = await mkdtemp(join(tmpdir(), "baerly-legacy-names-"));
    try {
      const config = join(dir, "baerly.config.json");
      await writeFile(
        config,
        JSON.stringify({ collections: { [NFD]: { indexes: [{ name: "by_kind", on: "kind" }] } } }),
      );
      const fixed = await captured(() =>
        runFsck([...flags, "--indexes", "--fix", `--config=${config}`]),
      );
      expect(fixed.code).toBe(1);
      // Read-only drift check on the same legacy name still runs.
      const checked = await captured(() => runFsck([...flags, "--indexes", `--config=${config}`]));
      expect(checked.code).toBe(4);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    const indexKeys: string[] = [];
    for await (const e of storage.list(`app/app/tenant/tenant/manifests/${NFD}/index/`)) {
      indexKeys.push(e.key);
    }
    expect(indexKeys).toEqual([]);
  });
});

describe("admin dump flags legacy row ids", () => {
  test("reports non-NFC ids and canonically-equivalent twins, and still exports every row", async () => {
    const { uri, storage } = freshBucket();
    const rows = [
      { _id: NFC, kind: "x" },
      { _id: NFD, kind: "y" },
      { _id: "ñ", kind: "z" },
      { _id: "plain", kind: "w" },
    ];
    await seedCollection(storage, { app: "app", tenant: "tenant", collection: "rows" }, rows);
    const flags = [`--bucket=${uri}`, "--app=app", "--tenant=tenant", "--collection=rows"];

    const out = sink();
    const json = await captured(() =>
      runDump([...flags, "--json"], { streams: { stdout: out.stream } }),
    );
    expect(json.code).toBe(0);
    expect(out.text().trim().split("\n")).toHaveLength(4);
    const envelope = JSON.parse(json.stdout.trim()) as {
      result: { legacy: { non_nfc_names: string[]; non_nfc_ids: string[]; twin_ids: string[][] } };
    };
    expect(envelope.result.legacy).toEqual({
      non_nfc_names: [],
      non_nfc_ids: [NFD, "ñ"],
      twin_ids: [[NFD, NFC]],
    });

    // Text mode keeps stdout for the NDJSON and warns on stderr.
    const text = await captured(() => runDump(flags, { streams: { stdout: sink().stream } }));
    expect(text.code).toBe(0);
    expect(text.stderr).toContain("twin");
  });

  test("a clean collection reports nothing", async () => {
    const { uri, storage } = freshBucket();
    await seedCollection(storage, { app: "app", tenant: "tenant", collection: "rows" }, ROWS);
    const res = await captured(() =>
      runDump([`--bucket=${uri}`, "--app=app", "--tenant=tenant", "--collection=rows", "--json"], {
        streams: { stdout: sink().stream },
      }),
    );
    const envelope = JSON.parse(res.stdout.trim()) as { result: { legacy: unknown } };
    expect(envelope.result.legacy).toEqual({ non_nfc_names: [], non_nfc_ids: [], twin_ids: [] });
    expect(res.stderr).toBe("");
  });
});
