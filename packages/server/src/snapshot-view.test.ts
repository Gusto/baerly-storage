import { fc, test as fcTest } from "@fast-check/vitest";
import {
  MemoryStorage,
  snapshotHash,
  type DocumentData,
  type Storage,
  type StorageGetOptions,
  type StorageGetResult,
  type StorageListEntry,
  type StoragePutOptions,
  type StoragePutResult,
} from "@baerly/protocol";
import { describe, expect, test } from "vitest";
import { foldChunkedSnapshotReference } from "./chunked-snapshot-reference.ts";
import { encodeSnapshotChunk, snapshotChunkKey, type SnapshotChunk } from "./snapshot-chunk.ts";
import {
  encodeSnapshotManifest,
  snapshotManifestKey,
  type SnapshotChunkDescriptor,
  type SnapshotManifest,
} from "./snapshot-manifest.ts";
import { openSnapshotView, type SnapshotRow } from "./snapshot-view.ts";

const COLLECTION = "tickets";
const PREFIX = "app/t/tenant/x/manifests/tickets";
const INCARNATION = "0123456789abcdef0123456789abcdef";
const FLOOR = 41;

interface ReadRecord {
  readonly key: string;
  readonly bytes: number;
}

class CountingStorage implements Storage {
  readonly reads: ReadRecord[] = [];
  readonly inner: Storage;
  puts = 0;
  deletes = 0;
  lists = 0;

  constructor(inner: Storage) {
    this.inner = inner;
  }

  async get(key: string, opts?: StorageGetOptions): Promise<StorageGetResult | null> {
    const result = await this.inner.get(key, opts);
    this.reads.push({ key, bytes: result?.body.byteLength ?? 0 });
    return result;
  }

  async put(key: string, body: Uint8Array, opts?: StoragePutOptions): Promise<StoragePutResult> {
    this.puts++;
    return this.inner.put(key, body, opts);
  }

  async delete(key: string, opts?: { signal?: AbortSignal }): Promise<void> {
    this.deletes++;
    return this.inner.delete(key, opts);
  }

  async *list(
    prefix: string,
    opts?: { startAfter?: string; maxKeys?: number; signal?: AbortSignal },
  ): AsyncIterable<StorageListEntry> {
    this.lists++;
    yield* this.inner.list(prefix, opts);
  }

  reset(): void {
    this.reads.length = 0;
    this.puts = 0;
    this.deletes = 0;
    this.lists = 0;
  }
}

interface Fixture {
  readonly inner: MemoryStorage;
  readonly storage: CountingStorage;
  readonly manifestKey: string;
  readonly manifestBytes: Uint8Array;
  readonly descriptors: readonly SnapshotChunkDescriptor[];
  readonly chunkBytes: ReadonlyMap<string, Uint8Array>;
  readonly rows: readonly SnapshotRow[];
}

const document = (_id: string, value: number): DocumentData => ({ _id, value });

const seedFixture = async (
  groups: readonly (readonly DocumentData[])[],
  floor = FLOOR,
): Promise<Fixture> => {
  const inner = new MemoryStorage();
  const descriptors: SnapshotChunkDescriptor[] = [];
  const chunkBytes = new Map<string, Uint8Array>();
  for (const docs of groups) {
    const chunk: SnapshotChunk = {
      schema_version: 2,
      collection: COLLECTION,
      incarnation: INCARNATION,
      first_id: docs[0]!["_id"] as string,
      last_id: docs.at(-1)!["_id"] as string,
      docs,
    };
    const bytes = encodeSnapshotChunk(chunk);
    const key = snapshotChunkKey(PREFIX, INCARNATION, await snapshotHash(bytes));
    const descriptor: SnapshotChunkDescriptor = {
      first_id: chunk.first_id,
      last_id: chunk.last_id,
      key,
      byte_length: bytes.byteLength,
      row_count: docs.length,
    };
    await inner.put(key, bytes);
    descriptors.push(descriptor);
    chunkBytes.set(key, bytes);
  }
  const manifest: SnapshotManifest = {
    schema_version: 2,
    collection: COLLECTION,
    log_seq_start: floor,
    incarnation: INCARNATION,
    collation: "utf8-scalar-v1",
    chunks: descriptors,
  };
  const manifestBytes = encodeSnapshotManifest(manifest);
  const manifestKey = snapshotManifestKey(PREFIX, INCARNATION, await snapshotHash(manifestBytes));
  await inner.put(manifestKey, manifestBytes);
  return {
    inner,
    storage: new CountingStorage(inner),
    manifestKey,
    manifestBytes,
    descriptors,
    chunkBytes,
    rows: groups.flatMap((docs) => docs.map((body) => ({ _id: body["_id"] as string, body }))),
  };
};

const open = (fixture: Fixture, expectedLogSeqStart = FLOOR) =>
  openSnapshotView({
    storage: fixture.storage,
    manifestKey: fixture.manifestKey,
    collection: COLLECTION,
    expectedLogSeqStart,
  });

const collect = async (rows: AsyncIterable<SnapshotRow>): Promise<SnapshotRow[]> => {
  const result: SnapshotRow[] = [];
  for await (const row of rows) {
    result.push(row);
  }
  return result;
};

describe("openSnapshotView", () => {
  test("opens a null manifest as an empty captured base without storage I/O", async () => {
    const storage = new CountingStorage(new MemoryStorage());
    const view = await openSnapshotView({
      storage,
      manifestKey: null,
      collection: COLLECTION,
      expectedLogSeqStart: 913,
    });

    await expect(view.get("a")).resolves.toBeUndefined();
    await expect(collect(view.scan())).resolves.toEqual([]);
    await expect(view.materialize()).resolves.toEqual(new Map());
    expect(storage.reads).toEqual([]);
    expect({ puts: storage.puts, deletes: storage.deletes, lists: storage.lists }).toEqual({
      puts: 0,
      deletes: 0,
      lists: 0,
    });
  });

  test("authenticates the manifest once and rejects a captured-head floor mismatch", async () => {
    const fixture = await seedFixture([[document("a", 1)]], FLOOR + 1);

    await expect(open(fixture)).rejects.toMatchObject({ code: "InvalidResponse" });
    expect(fixture.storage.reads).toEqual([
      { key: fixture.manifestKey, bytes: fixture.manifestBytes.byteLength },
    ]);
  });

  test("routes point hits and misses without fetching unrelated chunks", async () => {
    const fixture = await seedFixture([
      [document("a", 1), document("aa", 2)],
      [document("c", 3), document("d", 4)],
      [document("é", 5), document("😀", 6)],
    ]);
    const view = await open(fixture);
    expect(fixture.storage.reads).toHaveLength(1);
    fixture.storage.reset();

    await expect(view.get("aa")).resolves.toEqual(document("aa", 2));
    expect(fixture.storage.reads.map(({ key }) => key)).toEqual([fixture.descriptors[0]!.key]);
    // A point read fetches exactly one chunk.
    expect(fixture.storage.reads).toHaveLength(1);

    fixture.storage.reset();
    await expect(view.get("b")).resolves.toBeUndefined();
    await expect(view.get("zz")).resolves.toBeUndefined();
    expect(fixture.storage.reads).toEqual([]);
  });

  test("uses prefix-first boundaries and fetches exactly the intersecting range chunks", async () => {
    const fixture = await seedFixture([
      [document("a", 1), document("aa", 2)],
      [document("c", 3), document("d", 4)],
      [document("é", 5), document("😀", 6)],
    ]);
    const view = await open(fixture);
    fixture.storage.reset();

    await expect(collect(view.scan({ gte: "aa", lt: "é" }))).resolves.toEqual([
      { _id: "aa", body: document("aa", 2) },
      { _id: "c", body: document("c", 3) },
      { _id: "d", body: document("d", 4) },
    ]);
    expect(fixture.storage.reads.map(({ key }) => key)).toEqual(
      fixture.descriptors.slice(0, 2).map(({ key }) => key),
    );
    expect(fixture.storage.reads.reduce((sum, read) => sum + read.bytes, 0)).toBe(
      fixture.descriptors.slice(0, 2).reduce((sum, descriptor) => sum + descriptor.byte_length, 0),
    );
  });

  test("does not fetch any chunk for an empty or gap-only range", async () => {
    const fixture = await seedFixture([[document("a", 1)], [document("c", 3)]]);
    const view = await open(fixture);
    fixture.storage.reset();

    await expect(collect(view.scan({ gte: "b", lt: "c" }))).resolves.toEqual([]);
    await expect(collect(view.scan({ gte: "c", lt: "c" }))).resolves.toEqual([]);
    expect(fixture.storage.reads).toEqual([]);
  });

  test("scans each descriptor once in order and materializes only through scan", async () => {
    const fixture = await seedFixture([
      [document("a", 1), document("aa", 2)],
      [document("c", 3)],
      [document("😀", 4)],
    ]);
    const view = await open(fixture);
    fixture.storage.reset();

    await expect(collect(view.scan())).resolves.toEqual(fixture.rows);
    expect(fixture.storage.reads.map(({ key }) => key)).toEqual(
      fixture.descriptors.map(({ key }) => key),
    );
    expect(fixture.storage.reads.reduce((sum, read) => sum + read.bytes, 0)).toBe(
      [...fixture.chunkBytes.values()].reduce((sum, bytes) => sum + bytes.byteLength, 0),
    );

    fixture.storage.reset();
    await expect(view.materialize()).resolves.toEqual(
      new Map(fixture.rows.map(({ _id, body }) => [_id, body])),
    );
    expect(fixture.storage.reads.map(({ key }) => key)).toEqual(
      fixture.descriptors.map(({ key }) => key),
    );
    expect({
      puts: fixture.storage.puts,
      deletes: fixture.storage.deletes,
      lists: fixture.storage.lists,
    }).toEqual({ puts: 0, deletes: 0, lists: 0 });
  });

  test("defers corruption in an unfetched body until that body is selected", async () => {
    const fixture = await seedFixture([[document("a", 1)], [document("c", 3)]]);
    const corruptDescriptor = fixture.descriptors[1]!;
    const corruptBytes = fixture.chunkBytes.get(corruptDescriptor.key)!.slice();
    corruptBytes[0] = corruptBytes[0]! ^ 1;
    await fixture.inner.put(corruptDescriptor.key, corruptBytes);
    const view = await open(fixture);
    fixture.storage.reset();

    await expect(view.get("a")).resolves.toEqual(document("a", 1));
    await expect(view.get("b")).resolves.toBeUndefined();
    expect(fixture.storage.reads.map(({ key }) => key)).toEqual([fixture.descriptors[0]!.key]);

    await expect(view.get("c")).rejects.toMatchObject({ code: "InvalidResponse" });
    await expect(view.materialize()).rejects.toMatchObject({ code: "InvalidResponse" });
  });

  test("fails closed when the manifest or a selected chunk is missing", async () => {
    const storage = new CountingStorage(new MemoryStorage());
    await expect(
      openSnapshotView({
        storage,
        manifestKey: `${PREFIX}/_v2/snapshot/manifests/${INCARNATION}/sha256/${"0".repeat(64)}.json`,
        collection: COLLECTION,
        expectedLogSeqStart: FLOOR,
      }),
    ).rejects.toMatchObject({ code: "InvalidResponse" });

    const fixture = await seedFixture([[document("a", 1)]]);
    await fixture.inner.delete(fixture.descriptors[0]!.key);
    const view = await open(fixture);
    await expect(view.get("a")).rejects.toMatchObject({ code: "InvalidResponse" });
  });
});

fcTest.prop({
  numbers: fc.uniqueArray(fc.integer({ min: 0, max: 999 }), { maxLength: 12 }),
  chunkRows: fc.integer({ min: 1, max: 4 }),
})("generated views are equivalent to the reference fold", async ({ numbers, chunkRows }) => {
  const docs = numbers
    .toSorted((left, right) => left - right)
    .map((value) => document(`id-${value.toString().padStart(3, "0")}`, value));
  const groups: DocumentData[][] = [];
  for (let index = 0; index < docs.length; index += chunkRows) {
    groups.push(docs.slice(index, index + chunkRows));
  }
  const fixture = await seedFixture(groups);
  const expected = foldChunkedSnapshotReference(fixture.rows, []);
  const view = await open(fixture);

  await expect(collect(view.scan())).resolves.toEqual(expected);
  await expect(view.materialize()).resolves.toEqual(
    new Map(expected.map(({ _id, body }) => [_id, body])),
  );

  const pointId = expected[Math.floor(expected.length / 2)]?._id ?? "id-500";
  await expect(view.get(pointId)).resolves.toEqual(
    expected.find(({ _id }) => _id === pointId)?.body,
  );

  const gte = "id-250";
  const lt = "id-750";
  await expect(collect(view.scan({ gte, lt }))).resolves.toEqual(
    expected.filter(({ _id }) => _id >= gte && _id < lt),
  );
});
