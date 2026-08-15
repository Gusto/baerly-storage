import { fc, test as fcTest } from "@fast-check/vitest";
import { BaerlyError, type DocumentData, encodeJsonBytes, snapshotHash } from "@baerly/protocol";
import { describe, expect, test } from "vitest";
import {
  decodeSnapshotChunk,
  encodeSnapshotChunk,
  snapshotChunkKey,
  type SnapshotChunk,
} from "./snapshot-chunk.ts";
import { compareDocIds } from "./snapshot-doc-id.ts";
import type { SnapshotChunkDescriptor } from "./snapshot-manifest.ts";

const prefix = "app/demo/tenant/acme/manifests/tickets";
const incarnation = "00112233445566778899aabbccddeeff";
const otherIncarnation = "ffeeddccbbaa99887766554433221100";

const chunk = (overrides: Partial<SnapshotChunk> = {}): SnapshotChunk => ({
  schema_version: 2,
  collection: "tickets",
  incarnation,
  first_id: "a",
  last_id: "é",
  docs: [
    { _id: "a", value: 1 },
    { _id: "é", value: "nfd" },
    { _id: "é", value: "nfc" },
  ],
  ...overrides,
});

const keyFor = async (bytes: Uint8Array, bodyIncarnation = incarnation): Promise<string> =>
  snapshotChunkKey(prefix, bodyIncarnation, await snapshotHash(bytes));

const descriptorFor = async (
  bytes: Uint8Array,
  value: SnapshotChunk,
  overrides: Partial<SnapshotChunkDescriptor> = {},
): Promise<SnapshotChunkDescriptor> => ({
  first_id: value.first_id,
  last_id: value.last_id,
  key: await keyFor(bytes, value.incarnation),
  byte_length: bytes.byteLength,
  row_count: value.docs.length,
  ...overrides,
});

const decode = async (
  bytes: Uint8Array,
  value: SnapshotChunk,
  overrides: Partial<SnapshotChunkDescriptor> = {},
): Promise<SnapshotChunk> => {
  const descriptor = await descriptorFor(bytes, value, overrides);
  return decodeSnapshotChunk(bytes, descriptor.key, "tickets", descriptor);
};

const expectInvalidResponse = async (operation: Promise<unknown>): Promise<void> => {
  await expect(operation).rejects.toBeInstanceOf(BaerlyError);
  await expect(operation).rejects.toMatchObject({ code: "InvalidResponse" });
};

describe("snapshot chunk codec", () => {
  test("pins the accepted three-row bytes and key", async () => {
    const value = chunk();
    const bytes = encodeSnapshotChunk(value);
    expect(new TextDecoder().decode(bytes)).toBe(
      '{"schema_version":2,"collection":"tickets","incarnation":"00112233445566778899aabbccddeeff","first_id":"a","last_id":"é","docs":[{"_id":"a","value":1},{"_id":"é","value":"nfd"},{"_id":"é","value":"nfc"}]}',
    );
    expect(bytes.byteLength).toBe(208);
    const descriptor = await descriptorFor(bytes, value);
    expect(descriptor.key).toBe(
      `${prefix}/_v2/snapshot/chunks/${incarnation}/sha256/96ae5ba511993addb97ba19c51004528a6cb5c278610352eb4478f4436a4315a.json`,
    );
    await expect(
      decodeSnapshotChunk(bytes, descriptor.key, "tickets", descriptor),
    ).resolves.toEqual(value);
  });

  test("pins a single-row chunk and a 4,096-row boundary chunk", async () => {
    const single = chunk({ first_id: "a", last_id: "a", docs: [{ value: 1, _id: "a" }] });
    const singleBytes = encodeSnapshotChunk(single);
    expect(new TextDecoder().decode(singleBytes)).toBe(
      '{"schema_version":2,"collection":"tickets","incarnation":"00112233445566778899aabbccddeeff","first_id":"a","last_id":"a","docs":[{"_id":"a","value":1}]}',
    );
    await expect(keyFor(singleBytes)).resolves.toBe(
      `${prefix}/_v2/snapshot/chunks/${incarnation}/sha256/f8ffeec92ecfab1fe15a089ad9416550cbca3f47e2b5a67983be9a5c5e0367a2.json`,
    );

    const docs = Array.from({ length: 4096 }, (_, index) => ({
      _id: `id${index.toString().padStart(4, "0")}`,
      value: index,
    }));
    const boundary = chunk({ first_id: "id0000", last_id: "id4095", docs });
    const boundaryBytes = encodeSnapshotChunk(boundary);
    expect(boundaryBytes.byteLength).toBe(121_910);
    await expect(keyFor(boundaryBytes)).resolves.toBe(
      `${prefix}/_v2/snapshot/chunks/${incarnation}/sha256/2c6542fa5c534d7011bbc7a5b98084402c8e13ecd0103413ad1ebeb5f58c1d08.json`,
    );
    await expect(decode(boundaryBytes, boundary)).resolves.toEqual(boundary);
  });

  test("canonicalizes document members recursively in deterministic ECMAScript order", async () => {
    const value = chunk({
      first_id: "a",
      last_id: "a",
      docs: [
        {
          z: { zebra: true, alpha: false, 10: "ten", 2: "two" },
          _id: "a",
          a: [{ z: 1, a: 2 }],
        },
      ],
    });
    const bytes = encodeSnapshotChunk(value);
    expect(new TextDecoder().decode(bytes)).toContain(
      '"docs":[{"_id":"a","a":[{"a":2,"z":1}],"z":{"2":"two","10":"ten","alpha":false,"zebra":true}}]',
    );
    const decoded = await decode(bytes, {
      ...value,
      docs: [
        { _id: "a", a: [{ a: 2, z: 1 }], z: { 2: "two", 10: "ten", alpha: false, zebra: true } },
      ],
    });
    expect(decoded.docs[0]).toEqual(value.docs[0]);
  });

  test.each<[string, Record<string, unknown>]>([
    ["unknown envelope field", { ...chunk(), surprise: true }],
    ["unsupported schema", { ...chunk(), schema_version: 3 }],
    ["invalid incarnation", { ...chunk(), incarnation: incarnation.toUpperCase() }],
    ["empty document list", { ...chunk(), first_id: "a", last_id: "a", docs: [] }],
    ["missing _id", { ...chunk(), first_id: "a", last_id: "a", docs: [{ value: 1 }] }],
    [
      "invalid scalar ID",
      { ...chunk(), first_id: "\ud800", last_id: "\ud800", docs: [{ _id: "\ud800" }] },
    ],
    [
      "null stored value",
      { ...chunk(), first_id: "a", last_id: "a", docs: [{ _id: "a", value: null }] },
    ],
    ["non-object document", { ...chunk(), first_id: "a", last_id: "a", docs: ["a"] }],
    [
      "duplicate IDs",
      { ...chunk(), first_id: "a", last_id: "a", docs: [{ _id: "a" }, { _id: "a" }] },
    ],
    [
      "decreasing IDs",
      { ...chunk(), first_id: "b", last_id: "a", docs: [{ _id: "b" }, { _id: "a" }] },
    ],
    ["wrong first range", { ...chunk(), first_id: "b" }],
    ["wrong last range", { ...chunk(), last_id: "z" }],
  ])("rejects stored %s", async (_label, body) => {
    const bytes = encodeJsonBytes(body);
    const bodyIncarnation = String(body["incarnation"]);
    const key = await keyFor(
      bytes,
      /^[0-9a-f]{32}$/.test(bodyIncarnation) ? bodyIncarnation : incarnation,
    );
    const descriptor: SnapshotChunkDescriptor = {
      first_id: String(body["first_id"]),
      last_id: String(body["last_id"]),
      key,
      byte_length: bytes.byteLength,
      row_count: Array.isArray(body["docs"]) ? body["docs"].length : 1,
    };
    await expectInvalidResponse(decodeSnapshotChunk(bytes, key, "tickets", descriptor));
  });

  test("rejects 4,097 rows and an over-1-MiB canonical body", async () => {
    const tooManyDocs = Array.from({ length: 4097 }, (_, index) => ({
      _id: `id${index.toString().padStart(4, "0")}`,
    }));
    const tooMany = chunk({ first_id: "id0000", last_id: "id4096", docs: tooManyDocs });
    const tooManyBytes = encodeJsonBytes(tooMany);
    await expectInvalidResponse(decode(tooManyBytes, tooMany));

    const oversized = chunk({
      first_id: "a",
      last_id: "a",
      docs: [{ _id: "a", value: "x".repeat(1_048_576) }],
    });
    const oversizedBytes = encodeJsonBytes(oversized);
    await expectInvalidResponse(decode(oversizedBytes, oversized));
  });

  test.each<[string, Partial<SnapshotChunkDescriptor> & { readonly expectedCollection?: string }]>([
    ["collection", { expectedCollection: "other" }],
    ["descriptor key", { key: "wrong" }],
    ["descriptor byte length", { byte_length: 1 }],
    ["descriptor row count", { row_count: 2 }],
    ["descriptor first ID", { first_id: "b" }],
    ["descriptor last ID", { last_id: "z" }],
  ])("rejects wrong %s claims", async (_label, claim) => {
    const value = chunk();
    const bytes = encodeSnapshotChunk(value);
    const validDescriptor = await descriptorFor(bytes, value);
    const expectedCollection = claim.expectedCollection ?? "tickets";
    const suppliedKey = claim.key ?? validDescriptor.key;
    const suppliedDescriptor = { ...validDescriptor, ...claim, key: suppliedKey };
    await expectInvalidResponse(
      decodeSnapshotChunk(bytes, suppliedKey, expectedCollection, suppliedDescriptor),
    );
  });

  test("rejects key/body incarnation disagreement but accepts an older reused chunk", async () => {
    const value = chunk();
    const bytes = encodeSnapshotChunk(value);
    const digest = await snapshotHash(bytes);
    const wrongKey = snapshotChunkKey(prefix, otherIncarnation, digest);
    await expectInvalidResponse(
      decodeSnapshotChunk(bytes, wrongKey, "tickets", {
        ...(await descriptorFor(bytes, value)),
        key: wrongKey,
      }),
    );

    const reused = chunk({ incarnation: otherIncarnation });
    const reusedBytes = encodeSnapshotChunk(reused);
    const reusedDescriptor = await descriptorFor(reusedBytes, reused);
    await expect(
      decodeSnapshotChunk(reusedBytes, reusedDescriptor.key, "tickets", reusedDescriptor),
    ).resolves.toEqual(reused);
  });

  test.each([
    ["wrong version", (key: string) => key.replace("/_v2/", "/_v3/")],
    ["wrong artifact kind", (key: string) => key.replace("/chunks/", "/manifests/")],
    ["wrong algorithm", (key: string) => key.replace("/sha256/", "/sha1/")],
    ["uppercase digest", (key: string) => key.replace(/[a-f](?=[0-9a-f]{0,63}\.json$)/, "A")],
    ["short digest", (key: string) => key.replace(/[0-9a-f]\.json$/, ".json")],
    ["wrong suffix", (key: string) => key.replace(".json", ".bin")],
    ["extra segment", (key: string) => key.replace("/sha256/", "/extra/sha256/")],
    ["empty prefix segment", (key: string) => key.replace("/_v2/", "//_v2/")],
  ])("rejects a key with %s", async (_label, corrupt) => {
    const value = chunk();
    const bytes = encodeSnapshotChunk(value);
    const descriptor = await descriptorFor(bytes, value);
    const key = corrupt(descriptor.key);
    await expectInvalidResponse(decodeSnapshotChunk(bytes, key, "tickets", { ...descriptor, key }));
  });

  test("rejects malformed, truncated, noncanonical, duplicate-member, and digest-mismatched bytes", async () => {
    const value = chunk();
    const malformed = new TextEncoder().encode("{");
    await expectInvalidResponse(decode(malformed, value));

    const canonical = encodeSnapshotChunk(value);
    const truncated = canonical.slice(0, -1);
    await expectInvalidResponse(decode(truncated, value));

    const spaced = new TextEncoder().encode(
      new TextDecoder().decode(canonical).replace(":2", ": 2"),
    );
    await expectInvalidResponse(decode(spaced, value));

    const duplicate = new TextEncoder().encode(
      new TextDecoder()
        .decode(canonical)
        .replace('"schema_version":2', '"schema_version":2,"schema_version":2'),
    );
    await expectInvalidResponse(decode(duplicate, value));

    const changed = canonical.slice();
    changed[changed.length - 2] = changed[changed.length - 2]! ^ 1;
    const descriptor = await descriptorFor(canonical, value);
    await expectInvalidResponse(
      decodeSnapshotChunk(changed, descriptor.key, "tickets", {
        ...descriptor,
        byte_length: changed.byteLength,
      }),
    );
  });

  test("decodes one private byte snapshot when the caller mutates the input during hashing", async () => {
    const value = chunk({ first_id: "a", last_id: "a", docs: [{ _id: "a", value: 1 }] });
    const bytes = encodeSnapshotChunk(value);
    const descriptor = await descriptorFor(bytes, value);
    const pending = decodeSnapshotChunk(bytes, descriptor.key, "tickets", descriptor);
    const marker = new TextEncoder().encode('"value":1');
    const offset = bytes.findIndex((_byte, index) =>
      marker.every((expected, markerIndex) => bytes[index + markerIndex] === expected),
    );
    expect(offset).toBeGreaterThanOrEqual(0);
    bytes[offset + marker.length - 1] = "2".charCodeAt(0);

    await expect(pending).resolves.toEqual(value);
  });

  test("rejects an oversized body before allocating a private copy", async () => {
    const bytes = new Uint8Array(1024 * 1024 + 1);
    let copied = false;
    Object.defineProperty(bytes, "slice", {
      value: () => {
        copied = true;
        throw new Error("oversized input must not be copied");
      },
    });
    const key = snapshotChunkKey(prefix, incarnation, "0".repeat(64));

    await expectInvalidResponse(
      decodeSnapshotChunk(bytes, key, "tickets", {
        first_id: "a",
        last_id: "a",
        key,
        byte_length: bytes.byteLength,
        row_count: 1,
      }),
    );
    expect(copied).toBe(false);
  });

  test("normalizes pathological stored and caller nesting as BaerlyError", async () => {
    const depth = 15_000;
    const raw = `{"schema_version":2,"collection":"tickets","incarnation":"${incarnation}","first_id":"a","last_id":"a","docs":[{"_id":"a","value":${"[".repeat(depth)}true${"]".repeat(depth)}}]}`;
    const bytes = new TextEncoder().encode(raw);
    const key = await keyFor(bytes);
    await expectInvalidResponse(
      decodeSnapshotChunk(bytes, key, "tickets", {
        first_id: "a",
        last_id: "a",
        key,
        byte_length: bytes.byteLength,
        row_count: 1,
      }),
    );

    let nested: unknown = true;
    for (let level = 0; level < depth; level++) {
      nested = [nested];
    }
    expect(() =>
      encodeSnapshotChunk(
        chunk({
          first_id: "a",
          last_id: "a",
          docs: [{ _id: "a", value: nested }] as unknown as DocumentData[],
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: "InvalidConfig" }));
  });

  test("rejects invalid caller values as InvalidConfig", () => {
    expect(() => snapshotChunkKey(prefix, incarnation, "A".repeat(64))).toThrowError(
      expect.objectContaining({ code: "InvalidConfig" }),
    );
    expect(() =>
      encodeSnapshotChunk(
        chunk({
          first_id: "a",
          last_id: "a",
          docs: [{ _id: "a", value: null }] as unknown as DocumentData[],
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: "InvalidConfig" }));

    const symbolField = Object.assign(chunk(), { [Symbol("unknown")]: true });
    expect(() => encodeSnapshotChunk(symbolField)).toThrowError(
      expect.objectContaining({ code: "InvalidConfig" }),
    );

    const accessorArray: unknown[] = [];
    Object.defineProperty(accessorArray, 0, { enumerable: true, get: () => "value" });
    accessorArray.length = 1;
    expect(() =>
      encodeSnapshotChunk(
        chunk({
          first_id: "a",
          last_id: "a",
          docs: [{ _id: "a", value: accessorArray }] as unknown as DocumentData[],
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: "InvalidConfig" }));
  });
});

const idArb = fc.oneof(
  fc.stringMatching(/^[a-z][a-z0-9]{0,5}$/),
  fc.constantFrom("é", "e\u0301", "\u{10000}", "\u{1f600}"),
);
const valueArb = fc.oneof(fc.string(), fc.integer(), fc.boolean());

fcTest.prop({
  rows: fc.uniqueArray(fc.tuple(idArb, valueArb), {
    minLength: 1,
    maxLength: 24,
    selector: ([id]) => id,
  }),
})("round-trips generated rows with deterministic bytes and keys", async ({ rows }) => {
  const docs = rows
    .map(([id, value]) => ({ value, nested: { z: true, a: false }, _id: id }))
    .toSorted((left, right) => compareDocIds(left._id, right._id));
  const value = chunk({ first_id: docs[0]!._id, last_id: docs.at(-1)!._id, docs });
  const first = encodeSnapshotChunk(value);
  const second = encodeSnapshotChunk(value);
  expect(second).toEqual(first);
  const firstKey = await keyFor(first);
  await expect(keyFor(second)).resolves.toBe(firstKey);
  await expect(decode(first, value)).resolves.toEqual({
    ...value,
    docs,
  });
});

fcTest.prop({ value: valueArb })(
  "changing only the incarnation changes canonical bytes and artifact keys",
  async ({ value: field }) => {
    const firstValue = chunk({ first_id: "a", last_id: "a", docs: [{ _id: "a", value: field }] });
    const secondValue = { ...firstValue, incarnation: otherIncarnation };
    const first = encodeSnapshotChunk(firstValue);
    const second = encodeSnapshotChunk(secondValue);
    expect(first).not.toEqual(second);
    const firstKey = await keyFor(first);
    const secondKey = await keyFor(second, otherIncarnation);
    expect(firstKey).not.toBe(secondKey);
  },
);
