/**
 * The document nesting cap: a written document, update patch or merged
 * post-image nests at most `MAX_DOCUMENT_DEPTH` levels (the root is level
 * 1). Covers the in-process verbs, HTTP (a body deep enough to overflow
 * the call stack is a 400, not a 500), and a row stored deeper before the
 * cap existed: readable, deletable, flattenable, never deepened.
 */

import {
  BaerlyError,
  type Collection,
  type DocumentData,
  encodeJsonBytes,
  MAX_DOCUMENT_DEPTH,
  MemoryStorage,
  type StoragePutOptions,
  type StoragePutResult,
} from "@baerly/protocol";
import { beforeEach, describe, expect, test } from "vitest";
import { logStateCurrentJson, seedLogEntry } from "../../../tests/fixtures/log-state.ts";
import { Db } from "./db.ts";
import { createRouter } from "./http/router.ts";

const APP = "test";
const TENANT = "t";
const COLL = "c";
const PREFIX = `app/${APP}/tenant/${TENANT}/manifests/${COLL}`;
const CURRENT_KEY = `${PREFIX}/current.json`;

/** A value `levels` objects deep (`{ d: { d: … { leaf: 1 } } }`). */
const nested = (levels: number): DocumentData => {
  let value: DocumentData = { leaf: 1 };
  for (let i = 1; i < levels; i++) {
    value = { d: value };
  }
  return value;
};

/** A document `levels` deep, the root included. */
const docOfDepth = (_id: string, levels: number): DocumentData => ({
  _id,
  v: nested(levels - 1),
});

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

const expectDepthRefusal = (err: BaerlyError): void => {
  expect(err.code).toBe("SchemaError");
  expect(err.retriable).toBe(false);
  expect(err.message).toContain(`${MAX_DOCUMENT_DEPTH}-level document limit`);
  expect(err.resolution).toBeDefined();
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

describe("document depth cap: in-process verbs", () => {
  let storage: CountingStorage;
  let coll: Collection<DocumentData>;

  beforeEach(() => {
    storage = new CountingStorage();
    coll = Db.create({ storage, app: APP, tenant: TENANT }).collection(COLL);
  });

  test("insert accepts a document exactly MAX_DOCUMENT_DEPTH levels deep", async () => {
    const doc = docOfDepth("at-cap", MAX_DOCUMENT_DEPTH);
    await coll.insert(doc);
    await expect(coll.get("at-cap")).resolves.toEqual(doc);
  });

  test("insert refuses one level past the cap, before any storage write", async () => {
    expectDepthRefusal(await caught(() => coll.insert(docOfDepth("over", MAX_DOCUMENT_DEPTH + 1))));
    expect(storage.puts).toBe(0);
  });

  test("replace accepts the cap and refuses one level past it, keeping the row", async () => {
    await coll.insert({ _id: "r", v: 1 });
    await coll.replace("r", docOfDepth("r", MAX_DOCUMENT_DEPTH));
    await expect(coll.get("r")).resolves.toEqual(docOfDepth("r", MAX_DOCUMENT_DEPTH));
    const puts = storage.puts;
    expectDepthRefusal(
      await caught(() => coll.replace("r", docOfDepth("r", MAX_DOCUMENT_DEPTH + 1))),
    );
    expect(storage.puts).toBe(puts);
    await expect(coll.get("r")).resolves.toEqual(docOfDepth("r", MAX_DOCUMENT_DEPTH));
  });

  test("an update patch at the cap commits; one level past it is refused before I/O", async () => {
    await coll.insert({ _id: "u" });
    // A patch `{ v: nested(MAX - 1) }` is itself MAX levels deep, and so
    // is the post-image it produces.
    await coll.update("u", { v: nested(MAX_DOCUMENT_DEPTH - 1) });
    await expect(coll.get("u")).resolves.toEqual(docOfDepth("u", MAX_DOCUMENT_DEPTH));
    const puts = storage.puts;
    expectDepthRefusal(await caught(() => coll.update("u", { w: nested(MAX_DOCUMENT_DEPTH) })));
    expect(storage.puts).toBe(puts);
  });

  test("a shallow patch that deepens the merged row past the cap is refused", async () => {
    await coll.insert(docOfDepth("m", MAX_DOCUMENT_DEPTH));
    // Under MAX - 1 objects of `v`, the leaf becomes one more object.
    let patch: DocumentData = { leaf: { x: 1 } };
    for (let i = 2; i < MAX_DOCUMENT_DEPTH; i++) {
      patch = { d: patch };
    }
    const err = await caught(() => coll.update("m", { v: patch }));
    expectDepthRefusal(err);
    await expect(coll.get("m")).resolves.toEqual(docOfDepth("m", MAX_DOCUMENT_DEPTH));
  });
});

describe("document depth cap: a row stored deeper than the cap", () => {
  const DEEP = MAX_DOCUMENT_DEPTH + 50;
  let coll: Collection<DocumentData>;

  beforeEach(async () => {
    const storage = new MemoryStorage();
    await seedStoredRows(storage, [docOfDepth("deep", DEEP)]);
    coll = Db.create({ storage, app: APP, tenant: TENANT }).collection(COLL);
  });

  test("stays readable", async () => {
    await expect(coll.get("deep")).resolves.toEqual(docOfDepth("deep", DEEP));
  });

  test("stays deletable", async () => {
    await expect(coll.delete("deep")).resolves.toEqual({ deleted: 1 });
    await expect(coll.get("deep")).resolves.toBeUndefined();
  });

  test("an update that flattens it under the cap commits", async () => {
    await coll.update("deep", { v: null, flat: true });
    await expect(coll.get("deep")).resolves.toEqual({ _id: "deep", flat: true });
  });

  test("an update that leaves it over the cap is refused", async () => {
    expectDepthRefusal(await caught(() => coll.update("deep", { flag: true })));
  });
});

describe("document depth cap: HTTP", () => {
  const send = async (
    app: ReturnType<typeof createRouter>,
    method: string,
    path: string,
    body: string,
  ): Promise<Response> =>
    await app.request(path, {
      method,
      headers: { "content-type": "application/json" },
      body,
    });

  /** `{ "d": { "d": … {} } }`, `levels` objects deep, as raw JSON text. */
  const deepJson = (levels: number): string =>
    `${'{"d":'.repeat(levels - 1)}{}${"}".repeat(levels - 1)}`;

  test.each([MAX_DOCUMENT_DEPTH + 1, 10_000, 100_000])(
    "a %i-level insert or patch body is a 400 SchemaError, and commits nothing",
    async (levels) => {
      const storage = new MemoryStorage();
      const app = createRouter({ db: Db.create({ storage, app: APP, tenant: TENANT }) });
      const created = await send(app, "POST", `/v1/c/${COLL}`, `{"doc":{"_id":"h"}}`);
      expect(created.status).toBe(201);
      for (const [method, path, field] of [
        ["POST", `/v1/c/${COLL}`, "doc"],
        ["PATCH", `/v1/c/${COLL}/h`, "patch"],
        ["PUT", `/v1/c/${COLL}/h`, "doc"],
      ] as const) {
        // The body's own `{ field: … }` wrapper is not part of the document.
        const res = await send(app, method, path, `{"${field}":${deepJson(levels)}}`);
        expect(res.status).toBe(400);
        const env = (await res.json()) as { error: { code: string; message: string } };
        expect(env.error.code).toBe("SchemaError");
        expect(env.error.message).toContain(`${MAX_DOCUMENT_DEPTH}-level document limit`);
      }
      const got = await app.request(`/v1/c/${COLL}/h`);
      await expect(got.json()).resolves.toMatchObject({ data: { _id: "h" } });
    },
  );
});
