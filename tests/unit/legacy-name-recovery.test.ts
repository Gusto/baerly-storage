/* eslint-disable no-underscore-dangle -- `_id` is the locked primary-key field. */
import { Writable } from "node:stream";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createCurrentJson,
  logObjectKey,
  MemoryStorage,
  SNAPSHOT_SCHEMA_VERSION,
  snapshotHash,
  type Storage,
} from "@baerly/protocol";
import { Db, encodeSnapshotBody, snapshotKey } from "@baerly/server";
import { runDump } from "../../packages/cli/src/admin/dump.ts";
import * as bucketUri from "../../packages/cli/src/bucket-uri.ts";
import { loadMaterialisedView } from "../../packages/cli/src/export/index.ts";
import { captureStream } from "../../packages/cli/src/_internal/testing.ts";
import { logStateCurrentJson, seedLogEntry } from "../fixtures/log-state.ts";

const NFC = "café";
const NFD = "cafe\u0301";
const prefix = (name: string): string => `app/app/tenant/tenant/manifests/${name}`;

const fixture = async (snapshotCollection?: string) => {
  const base = new MemoryStorage({ ephemeral: true });
  const storage: Storage = {
    get: (key, opts) => base.get(key.normalize("NFC"), opts),
    put: (key, body, opts) => base.put(key.normalize("NFC"), body, opts),
    delete: (key, opts) => base.delete(key.normalize("NFC"), opts),
    list: (key, opts) => base.list(key.normalize("NFC"), opts),
  };
  let snapshot: string | null = null;
  if (snapshotCollection !== undefined) {
    const bytes = encodeSnapshotBody({
      schema_version: SNAPSHOT_SCHEMA_VERSION,
      collection: snapshotCollection,
      min_seq: 0,
      max_seq: 1,
      docs: [{ _id: "snapshot-row", body: { _id: "snapshot-row", value: "base" } }],
    });
    snapshot = snapshotKey(prefix(snapshotCollection), 0, 1, await snapshotHash(bytes));
    await storage.put(snapshot, bytes);
  }
  const start = snapshot === null ? 0 : 1;
  await createCurrentJson(
    storage,
    `${prefix(NFD)}/current.json`,
    // Exercise both the trusted range and the unhinted tail.
    logStateCurrentJson({ snapshot, log_seq_start: start, tail_hint: start + 4 }),
  );
  const writes = [
    { collection: NFD, doc_id: "shared", after: { _id: "shared", value: "nfd-old" } },
    { collection: NFC, doc_id: "shared", after: { _id: "shared", value: "nfc" } },
    { collection: NFD, doc_id: "shared", op: "U" as const, after: { _id: "shared", value: "nfd" } },
    { collection: NFC, doc_id: "deleted", after: { _id: "deleted", value: "gone" } },
    { collection: NFD, doc_id: "deleted", after: { _id: "deleted", value: "kept" } },
    { collection: NFC, doc_id: "deleted", op: "D" as const },
  ];
  for (const [i, entry] of writes.entries()) {
    await seedLogEntry(storage, prefix(entry.collection), start + i, entry);
  }
  return { storage, snapshot };
};

afterEach(() => vi.restoreAllMocks());

describe("explicit recovery of mixed legacy collection names", () => {
  test.each([NFD, NFC])(
    "exports only the exact spelling %j, including updates and deletes",
    async (collection) => {
      const { storage } = await fixture();
      const writes = vi.spyOn(storage, "put");
      const deletes = vi.spyOn(storage, "delete");
      const args = { storage, collection, currentJsonKey: `${prefix(collection)}/current.json` };
      await expect(loadMaterialisedView(args)).rejects.toMatchObject({ code: "InvalidConfig" });
      const rows = await loadMaterialisedView({ ...args, recoverLegacyNames: true });
      expect([...(rows?.values() ?? [])]).toEqual(
        collection === NFC
          ? [{ _id: "shared", value: "nfc" }]
          : [
              { _id: "shared", value: "nfd" },
              { _id: "deleted", value: "kept" },
            ],
      );
      await expect(
        Db.create({ storage, app: "app", tenant: "tenant" }).collection(NFC).get("shared"),
      ).rejects.toMatchObject({ code: "InvalidConfig" });
      expect(writes).not.toHaveBeenCalled();
      expect(deletes).not.toHaveBeenCalled();
    },
  );

  test.each([NFD, NFC])(
    "includes a matching %j snapshot without merging the other log spelling",
    async (collection) => {
      const { storage } = await fixture(collection);
      const rows = await loadMaterialisedView({
        storage,
        collection,
        currentJsonKey: `${prefix(collection)}/current.json`,
        recoverLegacyNames: true,
      });
      expect(rows?.get("snapshot-row")).toEqual({ _id: "snapshot-row", value: "base" });
      expect(rows?.get("shared")).toEqual({
        _id: "shared",
        value: collection === NFC ? "nfc" : "nfd",
      });
    },
  );

  test("refuses an opposite-spelling snapshot instead of silently exporting a partial view", async () => {
    const { storage } = await fixture(NFD);
    await expect(
      loadMaterialisedView({
        storage,
        collection: NFC,
        currentJsonKey: `${prefix(NFC)}/current.json`,
        recoverLegacyNames: true,
      }),
    ).rejects.toMatchObject({ code: "InvalidConfig" });
  });

  test("still verifies snapshot hashes during recovery", async () => {
    const { storage, snapshot } = await fixture(NFD);
    await storage.put(snapshot!, new TextEncoder().encode("{}"));
    await expect(
      loadMaterialisedView({
        storage,
        collection: NFD,
        currentJsonKey: `${prefix(NFD)}/current.json`,
        recoverLegacyNames: true,
      }),
    ).rejects.toMatchObject({ code: "Internal" });
  });

  test("refuses a missing log entry inside the trusted range during recovery", async () => {
    const { storage } = await fixture();
    await storage.delete(logObjectKey(prefix(NFD), 1));
    await expect(
      loadMaterialisedView({
        storage,
        collection: NFD,
        currentJsonKey: `${prefix(NFD)}/current.json`,
        recoverLegacyNames: true,
      }),
    ).rejects.toMatchObject({ code: "Internal" });
  });

  test("admin dump exposes recovery explicitly and reports its limitations", async () => {
    const { storage } = await fixture();
    vi.spyOn(bucketUri, "parseBucketUri").mockResolvedValue({ storage, keyPrefix: "" });
    let body = "";
    const stdout = new Writable({
      write(chunk, _enc, done) {
        body += chunk.toString();
        done();
      },
    });
    const out = captureStream(process.stdout);
    const err = captureStream(process.stderr);
    try {
      const flags = [
        "--bucket=memory://recovery",
        "--app=app",
        "--tenant=tenant",
        `--collection=${NFC}`,
      ];
      await expect(runDump(flags, { streams: { stdout } })).resolves.toBe(1);
      expect(body).toBe("");
      await expect(
        runDump([...flags, "--recover-legacy-names", "--json"], { streams: { stdout } }),
      ).resolves.toBe(0);
      expect(
        body
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      ).toEqual([{ _id: "shared", value: "nfc" }]);
      expect(JSON.parse(out.captured.join("")).result.recovery).toEqual({
        collection_match: "exact",
        historical_completeness: "not_guaranteed",
      });
      await expect(
        runDump([...flags, "--recover-legacy-names"], { streams: { stdout } }),
      ).resolves.toBe(0);
      expect(err.captured.join("")).toContain("historical completeness is not guaranteed");
    } finally {
      out.restore();
      err.restore();
    }
  });

  test.each([
    // A lone surrogate in a row id under one spelling of a mixed log.
    { collection: NFD, ids: [NFD, NFC], names: ["collection"], illFormedNames: [] },
    // A lone surrogate in the collection name itself; R2 folds nothing here.
    { collection: "lone\ud800", ids: ["lone\ud800"], names: [], illFormedNames: ["collection"] },
  ])(
    "reports unpaired surrogates under exact-spelling recovery of $collection",
    async ({ collection, ids, names, illFormedNames }) => {
      const base = new MemoryStorage({ ephemeral: true });
      const storage: Storage = {
        get: (key, opts) => base.get(key.normalize("NFC"), opts),
        put: (key, body, opts) => base.put(key.normalize("NFC"), body, opts),
        delete: (key, opts) => base.delete(key.normalize("NFC"), opts),
        list: (key, opts) => base.list(key.normalize("NFC"), opts),
      };
      await createCurrentJson(
        storage,
        `${prefix(collection)}/current.json`,
        logStateCurrentJson({ snapshot: null, log_seq_start: 0, tail_hint: ids.length }),
      );
      // Each spelling in `ids` writes its own ill-formed row; only the
      // selected spelling's row may be exported and reported.
      for (const [i, spelling] of ids.entries()) {
        const docId = `bad-${i}-\udc00`;
        await seedLogEntry(storage, prefix(spelling), i, {
          collection: spelling,
          doc_id: docId,
          after: { _id: docId, value: spelling },
        });
      }
      vi.spyOn(bucketUri, "parseBucketUri").mockResolvedValue({ storage, keyPrefix: "" });
      let body = "";
      const stdout = new Writable({
        write(chunk, _enc, done) {
          body += chunk.toString();
          done();
        },
      });
      const out = captureStream(process.stdout);
      const err = captureStream(process.stderr);
      try {
        const flags = [
          "--bucket=memory://recovery",
          "--app=app",
          "--tenant=tenant",
          `--collection=${collection}`,
          "--recover-legacy-names",
          "--json",
        ];
        await expect(runDump(flags, { streams: { stdout } })).resolves.toBe(0);
        expect(body.trim().split("\n")).toHaveLength(1);
        expect(JSON.parse(out.captured.join("")).result.legacy).toEqual({
          non_nfc_names: names,
          ill_formed_names: illFormedNames,
          non_nfc_ids: [],
          ill_formed_ids: ["bad-0-\udc00"],
          twin_ids: [],
        });
        // Text mode warns on stderr for exactly the reported roles.
        await expect(runDump(flags.slice(0, -1), { streams: { stdout } })).resolves.toBe(0);
        const warned = err.captured.join("");
        expect(warned).toContain("_id(s) with an unpaired UTF-16 surrogate");
        if (illFormedNames.length > 0) {
          expect(warned).toContain("collection name with an unpaired UTF-16 surrogate");
          expect(warned).toContain("the CLI cannot pass one");
        } else {
          expect(warned).not.toContain("name with an unpaired UTF-16 surrogate");
        }
      } finally {
        out.restore();
        err.restore();
      }
    },
  );
});
