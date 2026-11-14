/* eslint-disable no-underscore-dangle -- `_id` is the locked primary-key
   field on document shapes; tests assert on it by name. */

/**
 * The per-document size cap: a committed post-image encodes to at most
 * `MAX_DOCUMENT_BYTES`. Covers the in-process verbs, the writer itself
 * (direct callers such as `baerly admin restore`), HTTP merge-patch growth,
 * and the path for a row stored over the cap before it existed: readable,
 * deletable, shrinkable, never grown.
 */

import {
  BaerlyError,
  type Collection,
  type DocumentData,
  encodeJsonBytes,
  MAX_DOCUMENT_BYTES,
  MemoryStorage,
  type StoragePutOptions,
  type StoragePutResult,
} from "@baerly/protocol";
import { beforeEach, describe, expect, test } from "vitest";
import { logStateCurrentJson, seedLogEntry } from "../../../tests/fixtures/log-state.ts";
import { Db } from "./db.ts";
import { createRouter } from "./http/router.ts";
import { Writer } from "./writer.ts";

const APP = "test";
const TENANT = "t";
const COLL = "c";
const PREFIX = `app/${APP}/tenant/${TENANT}/manifests/${COLL}`;
const CURRENT_KEY = `${PREFIX}/current.json`;

/** A `{ _id, pad }` document whose encoding is exactly `bytes` bytes. */
const docOfBytes = (_id: string, bytes: number): DocumentData => {
  const overhead = encodeJsonBytes({ _id, pad: "" }).byteLength;
  const doc = { _id, pad: "a".repeat(bytes - overhead) };
  expect(encodeJsonBytes(doc).byteLength).toBe(bytes);
  return doc;
};

/** `MemoryStorage` that counts every `put`. */
class CountingStorage extends MemoryStorage {
  puts = 0;
  override async put(
    key: string,
    body: Uint8Array,
    opts?: StoragePutOptions,
  ): Promise<StoragePutResult> {
    this.puts += 1;
    return await super.put(key, body, opts);
  }
}

const caught = async (run: () => Promise<unknown>): Promise<BaerlyError> => {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(BaerlyError);
    return error as BaerlyError;
  }
  throw new Error("expected a BaerlyError");
};

/** Seed one stored `I` per doc from seq 0, as an earlier release could have written them. */
const seedStoredRows = async (
  storage: MemoryStorage,
  docs: readonly DocumentData[],
): Promise<void> => {
  await storage.put(CURRENT_KEY, encodeJsonBytes(logStateCurrentJson()));
  for (const [seq, doc] of docs.entries()) {
    await seedLogEntry(storage, PREFIX, seq, {
      op: "I",
      collection: COLL,
      doc_id: doc["_id"] as string,
      after: doc,
    });
  }
};

describe("per-document size cap: in-process verbs", () => {
  let storage: CountingStorage;
  let coll: Collection<DocumentData>;

  beforeEach(() => {
    storage = new CountingStorage();
    coll = Db.create({ storage, app: APP, tenant: TENANT }).collection(COLL);
  });

  test("insert accepts a document of exactly MAX_DOCUMENT_BYTES", async () => {
    await coll.insert(docOfBytes("at-cap", MAX_DOCUMENT_BYTES));
    await expect(coll.get("at-cap")).resolves.toBeDefined();
  });

  test("insert refuses one byte over, before any storage write", async () => {
    const err = await caught(() => coll.insert(docOfBytes("over", MAX_DOCUMENT_BYTES + 1)));
    expect(err.code).toBe("InvalidConfig");
    expect(err.retriable).toBe(false);
    expect(err.resolution).toBeDefined();
    expect(storage.puts).toBe(0);
  });

  test("replace refuses an over-cap document and keeps the row", async () => {
    await coll.insert({ _id: "r", v: 1 });
    const err = await caught(() => coll.replace("r", docOfBytes("r", MAX_DOCUMENT_BYTES + 1)));
    expect(err.code).toBe("InvalidConfig");
    await expect(coll.get("r")).resolves.toEqual({ _id: "r", v: 1 });
  });

  test("an update that grows a row past the cap is refused; the row is unchanged", async () => {
    await coll.insert(docOfBytes("u", MAX_DOCUMENT_BYTES - 10));
    const before = await coll.get("u");
    const err = await caught(() => coll.update("u", { more: "0123456789" }));
    expect(err.code).toBe("InvalidConfig");
    await expect(coll.get("u")).resolves.toEqual(before);
  });

  test("a multi-row update with one over-cap post-image commits no row", async () => {
    // Seeded, not inserted: two rows this large are past the default host's
    // fold ceiling, which would refuse the inserts first.
    await seedStoredRows(storage, [
      { _id: "a", group: 1, pad: "" },
      { ...docOfBytes("b", MAX_DOCUMENT_BYTES - 100), group: 1 },
    ]);
    const err = await caught(() =>
      coll.where({ group: 1 }).update({ pad2: "x".repeat(200) } as Partial<DocumentData>),
    );
    expect(err.code).toBe("InvalidConfig");
    await expect(coll.get("a")).resolves.toEqual({ _id: "a", group: 1, pad: "" });
  });
});

describe("per-document size cap: a row stored over the cap", () => {
  const OVERSIZED = MAX_DOCUMENT_BYTES + 4096;
  let storage: MemoryStorage;
  let coll: Collection<DocumentData>;

  beforeEach(async () => {
    storage = new MemoryStorage();
    await seedStoredRows(storage, [docOfBytes("big", OVERSIZED)]);
    coll = Db.create({ storage, app: APP, tenant: TENANT }).collection(COLL);
  });

  test("stays readable", async () => {
    const row = await coll.get("big");
    expect(row).toBeDefined();
    expect(encodeJsonBytes(row).byteLength).toBe(OVERSIZED);
  });

  test("stays deletable", async () => {
    await expect(coll.delete("big")).resolves.toEqual({ deleted: 1 });
    await expect(coll.get("big")).resolves.toBeUndefined();
  });

  test("an update that shrinks it under the cap commits", async () => {
    await coll.update("big", { pad: "small" });
    await expect(coll.get("big")).resolves.toEqual({ _id: "big", pad: "small" });
  });

  test("an update that leaves it over the cap is refused", async () => {
    const err = await caught(() => coll.update("big", { flag: true }));
    expect(err.code).toBe("InvalidConfig");
  });
});

describe("per-document size cap: Writer.commit", () => {
  test("refuses an over-cap I / U post-image before any storage write", async () => {
    const storage = new CountingStorage();
    const writer = new Writer({ storage, currentJsonKey: CURRENT_KEY });
    for (const op of ["I", "U"] as const) {
      const err = await caught(() =>
        writer.commit({
          op,
          collection: COLL,
          docId: "w",
          body: docOfBytes("w", MAX_DOCUMENT_BYTES + 1),
        }),
      );
      expect(err.code).toBe("InvalidConfig");
    }
    expect(storage.puts).toBe(0);
  });

  test("accepts a post-image of exactly MAX_DOCUMENT_BYTES", async () => {
    const writer = new Writer({ storage: new MemoryStorage(), currentJsonKey: CURRENT_KEY });
    const { entry } = await writer.commit({
      op: "I",
      collection: COLL,
      docId: "w",
      body: docOfBytes("w", MAX_DOCUMENT_BYTES),
    });
    expect(entry.seq).toBe(0);
  });
});

describe("per-document size cap: HTTP", () => {
  const send = async (
    app: ReturnType<typeof createRouter>,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> =>
    await app.request(path, {
      method,
      headers: { "content-type": "application/json" },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });

  test("merge-patches each under the body cap cannot grow a row past the document cap", async () => {
    const storage = new MemoryStorage();
    const app = createRouter({ db: Db.create({ storage, app: APP, tenant: TENANT }) });
    const half = "a".repeat(MAX_DOCUMENT_BYTES / 2);
    const created = await send(app, "POST", `/v1/c/${COLL}`, { doc: { _id: "h", a: half } });
    expect(created.status).toBe(201);
    const res = await send(app, "PATCH", `/v1/c/${COLL}/h`, { patch: { b: half } });
    expect(res.status).toBe(400);
    const env = (await res.json()) as { error: { code: string; resolution?: string } };
    expect(env.error.code).toBe("InvalidConfig");
    expect(env.error.resolution).toBeDefined();
    const got = await send(app, "GET", `/v1/c/${COLL}/h`);
    const row = (await got.json()) as DocumentData;
    expect(row["b"]).toBeUndefined();
  });

  test("a row stored over the cap is still served and deletable", async () => {
    const storage = new MemoryStorage();
    await seedStoredRows(storage, [docOfBytes("big", MAX_DOCUMENT_BYTES + 4096)]);
    const app = createRouter({ db: Db.create({ storage, app: APP, tenant: TENANT }) });
    const read = await send(app, "GET", `/v1/c/${COLL}/big`);
    expect(read.status).toBe(200);
    const deleted = await send(app, "DELETE", `/v1/c/${COLL}/big`);
    expect(deleted.status).toBe(204);
    const gone = await send(app, "GET", `/v1/c/${COLL}/big`);
    expect(gone.status).toBe(404);
  });
});
