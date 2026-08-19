import { fc, test as fcTest } from "@fast-check/vitest";
import { BaerlyError, encodeJsonBytes, snapshotHash } from "@baerly/protocol";
import { describe, expect, test } from "vitest";
import { LEAK_PATTERNS } from "./_internal/testing.ts";
import {
  decodeSnapshotManifest,
  encodeSnapshotManifest,
  snapshotManifestKey,
  type SnapshotChunkDescriptor,
  type SnapshotManifest,
} from "./snapshot-manifest.ts";
import { compareDocIds } from "./snapshot-doc-id.ts";

const prefix = "app/demo/tenant/acme/manifests/tickets";
const incarnation = "00112233445566778899aabbccddeeff";
const otherIncarnation = "ffeeddccbbaa99887766554433221100";
const fixedChunkKey = `${prefix}/_v2/snapshot/chunks/${incarnation}/sha256/96ae5ba511993addb97ba19c51004528a6cb5c278610352eb4478f4436a4315a.json`;

const descriptor = (overrides: Partial<SnapshotChunkDescriptor> = {}): SnapshotChunkDescriptor => ({
  first_id: "a",
  last_id: "é",
  key: fixedChunkKey,
  byte_length: 208,
  row_count: 3,
  ...overrides,
});

const manifest = (overrides: Partial<SnapshotManifest> = {}): SnapshotManifest => ({
  schema_version: 2,
  collection: "tickets",
  log_seq_start: 41,
  incarnation,
  collation: "utf8-scalar-v1",
  chunks: [descriptor()],
  ...overrides,
});

const keyFor = async (bytes: Uint8Array, bodyIncarnation = incarnation): Promise<string> =>
  snapshotManifestKey(prefix, bodyIncarnation, await snapshotHash(bytes));

const expectInvalidResponse = async (operation: Promise<unknown>): Promise<void> => {
  await expect(operation).rejects.toBeInstanceOf(BaerlyError);
  await expect(operation).rejects.toMatchObject({ code: "InvalidResponse" });
  // Ensure no validated field value leaks into the error message
  const caught = await operation.catch((error) => error);
  if (caught instanceof BaerlyError) {
    for (const pattern of LEAK_PATTERNS) {
      expect(pattern.test(caught.message)).toBe(false);
    }
  }
};

describe("snapshot manifest codec", () => {
  test("pins the empty manifest bytes and key", async () => {
    const value = manifest({ log_seq_start: 0, chunks: [] });
    const bytes = encodeSnapshotManifest(value);
    expect(new TextDecoder().decode(bytes)).toBe(
      '{"schema_version":2,"collection":"tickets","log_seq_start":0,"incarnation":"00112233445566778899aabbccddeeff","collation":"utf8-scalar-v1","chunks":[]}',
    );
    expect(bytes.byteLength).toBe(151);
    const key = await keyFor(bytes);
    expect(key).toBe(
      `${prefix}/_v2/snapshot/manifests/${incarnation}/sha256/049126f9dd4797176ce68f5faa2f86923eead5ac692b915715a9a766a369e696.json`,
    );
    await expect(decodeSnapshotManifest(bytes, key, "tickets", 0)).resolves.toEqual(value);
  });

  test("pins the accepted one-descriptor manifest vector", async () => {
    const value = manifest();
    const bytes = encodeSnapshotManifest(value);
    expect(new TextDecoder().decode(bytes)).toBe(
      '{"schema_version":2,"collection":"tickets","log_seq_start":41,"incarnation":"00112233445566778899aabbccddeeff","collation":"utf8-scalar-v1","chunks":[{"first_id":"a","last_id":"é","key":"app/demo/tenant/acme/manifests/tickets/_v2/snapshot/chunks/00112233445566778899aabbccddeeff/sha256/96ae5ba511993addb97ba19c51004528a6cb5c278610352eb4478f4436a4315a.json","byte_length":208,"row_count":3}]}',
    );
    expect(bytes.byteLength).toBe(392);
    const key = await keyFor(bytes);
    expect(key).toBe(
      `${prefix}/_v2/snapshot/manifests/${incarnation}/sha256/a82e680f7c003264d47a0ac3180f31eff3a8220518ec9b80dedc31be210944bf.json`,
    );
    await expect(decodeSnapshotManifest(bytes, key, "tickets", 41)).resolves.toEqual(value);
  });

  test("pins a multi-chunk manifest to deterministic bytes and a content key", async () => {
    const value = manifest({
      chunks: [
        descriptor(),
        descriptor({
          first_id: "😀",
          last_id: "😁",
          key: `${prefix}/_v2/snapshot/chunks/${otherIncarnation}/sha256/${"1".repeat(64)}.json`,
          byte_length: 144,
          row_count: 2,
        }),
      ],
    });
    const bytes = encodeSnapshotManifest(value);
    expect(new TextDecoder().decode(bytes)).toBe(
      `{"schema_version":2,"collection":"tickets","log_seq_start":41,"incarnation":"${incarnation}","collation":"utf8-scalar-v1","chunks":[{"first_id":"a","last_id":"é","key":"${fixedChunkKey}","byte_length":208,"row_count":3},{"first_id":"😀","last_id":"😁","key":"${prefix}/_v2/snapshot/chunks/${otherIncarnation}/sha256/${"1".repeat(64)}.json","byte_length":144,"row_count":2}]}`,
    );
    const key = await keyFor(bytes);
    expect(key).toBe(
      `${prefix}/_v2/snapshot/manifests/${incarnation}/sha256/e3eefbe4d5e2cf5c5aafe515d3ba7b81196828c95b76ab6b961b5589671cae82.json`,
    );
    await expect(decodeSnapshotManifest(bytes, key, "tickets", 41)).resolves.toEqual(value);
  });

  test.each([
    ["unknown envelope field", { ...manifest(), surprise: true }],
    ["unsupported schema", { ...manifest(), schema_version: 3 }],
    ["unsafe log floor", { ...manifest(), log_seq_start: Number.MAX_SAFE_INTEGER + 1 }],
    ["fractional log floor", { ...manifest(), log_seq_start: 1.5 }],
    ["negative log floor", { ...manifest(), log_seq_start: -1 }],
    ["wrong collation", { ...manifest(), collation: "locale" }],
    ["invalid incarnation", { ...manifest(), incarnation: incarnation.toUpperCase() }],
    ["unknown descriptor field", { ...manifest(), chunks: [{ ...descriptor(), surprise: true }] }],
    ["invalid first scalar", { ...manifest(), chunks: [descriptor({ first_id: "\ud800" })] }],
    ["reversed descriptor range", { ...manifest(), chunks: [descriptor({ first_id: "😀" })] }],
    ["zero byte length", { ...manifest(), chunks: [descriptor({ byte_length: 0 })] }],
    ["oversized byte length", { ...manifest(), chunks: [descriptor({ byte_length: 1_048_577 })] }],
    ["zero row count", { ...manifest(), chunks: [descriptor({ row_count: 0 })] }],
    ["oversized row count", { ...manifest(), chunks: [descriptor({ row_count: 4097 })] }],
    [
      "duplicate chunk key",
      {
        ...manifest(),
        chunks: [descriptor({ first_id: "a", last_id: "b" }), descriptor({ first_id: "c" })],
      },
    ],
    [
      "mismatched descriptor prefixes",
      {
        ...manifest(),
        chunks: [
          descriptor({ first_id: "a", last_id: "b" }),
          descriptor({
            first_id: "c",
            last_id: "d",
            key: fixedChunkKey.replace(prefix, "app/other"),
          }),
        ],
      },
    ],
    [
      "overlapping ranges",
      {
        ...manifest(),
        chunks: [
          descriptor({ first_id: "a", last_id: "m" }),
          descriptor({ first_id: "m", last_id: "z", key: fixedChunkKey.replace("96ae", "16ae") }),
        ],
      },
    ],
  ])("rejects stored %s", async (_label, body) => {
    const bytes = encodeJsonBytes(body);
    const keyIncarnation = /^[0-9a-f]{32}$/.test(String(body.incarnation))
      ? String(body.incarnation)
      : incarnation;
    await expectInvalidResponse(
      decodeSnapshotManifest(bytes, await keyFor(bytes, keyIncarnation), "tickets", 41),
    );
  });

  test("accepts descriptor gaps but rejects more than 32 descriptors", async () => {
    const gapped = manifest({
      chunks: [
        descriptor({ first_id: "a", last_id: "b" }),
        descriptor({
          first_id: "y",
          last_id: "z",
          key: fixedChunkKey.replace("96ae", "16ae"),
        }),
      ],
    });
    const bytes = encodeSnapshotManifest(gapped);
    await expect(
      decodeSnapshotManifest(bytes, await keyFor(bytes), "tickets", 41),
    ).resolves.toEqual(gapped);

    const tooMany = manifest({
      chunks: Array.from({ length: 33 }, (_, index) => {
        const id = `id${index.toString().padStart(2, "0")}`;
        return descriptor({
          first_id: id,
          last_id: id,
          key: `${prefix}/_v2/snapshot/chunks/${incarnation}/sha256/${index.toString(16).padStart(64, "0")}.json`,
          byte_length: 1,
          row_count: 1,
        });
      }),
    });
    const tooManyBytes = encodeJsonBytes(tooMany);
    await expectInvalidResponse(
      decodeSnapshotManifest(tooManyBytes, await keyFor(tooManyBytes), "tickets", 41),
    );
  });

  test.each([
    ["wrong collection", "other", 41],
    ["wrong expected floor", "tickets", 42],
  ])("rejects %s", async (_label, expectedCollection, expectedFloor) => {
    const bytes = encodeSnapshotManifest(manifest());
    await expectInvalidResponse(
      decodeSnapshotManifest(bytes, await keyFor(bytes), expectedCollection, expectedFloor),
    );
  });

  test("rejects key/body incarnation and collection-prefix disagreement", async () => {
    const bytes = encodeSnapshotManifest(manifest());
    const digest = await snapshotHash(bytes);
    await expectInvalidResponse(
      decodeSnapshotManifest(
        bytes,
        snapshotManifestKey(prefix, otherIncarnation, digest),
        "tickets",
        41,
      ),
    );

    const wrongPrefix = manifest({
      chunks: [descriptor({ key: fixedChunkKey.replace(prefix, "app/other") })],
    });
    const wrongPrefixBytes = encodeSnapshotManifest(wrongPrefix);
    await expectInvalidResponse(
      decodeSnapshotManifest(wrongPrefixBytes, await keyFor(wrongPrefixBytes), "tickets", 41),
    );
  });

  test.each([
    ["wrong version", (key: string) => key.replace("/_v2/", "/_v3/")],
    ["wrong artifact kind", (key: string) => key.replace("/manifests/", "/chunks/")],
    ["wrong algorithm", (key: string) => key.replace("/sha256/", "/sha1/")],
    [
      "wrong incarnation",
      (key: string) => key.replace(incarnation, incarnation.replace("00", "ff")),
    ],
    ["uppercase digest", (key: string) => key.replace(/[a-f](?=[0-9a-f]{0,63}\.json$)/, "A")],
    ["short digest", (key: string) => key.replace(/[0-9a-f]\.json$/, ".json")],
    ["wrong suffix", (key: string) => key.replace(".json", ".bin")],
    ["extra segment", (key: string) => key.replace("/sha256/", "/extra/sha256/")],
    ["empty prefix segment", (key: string) => key.replace("/_v2/", "//_v2/")],
  ])("rejects a key with %s", async (_label, corrupt) => {
    const bytes = encodeSnapshotManifest(manifest());
    await expectInvalidResponse(
      decodeSnapshotManifest(bytes, corrupt(await keyFor(bytes)), "tickets", 41),
    );
  });

  test("rejects malformed, truncated, noncanonical, duplicate-member, and digest-mismatched bytes", async () => {
    const malformed = new TextEncoder().encode("{");
    await expectInvalidResponse(
      decodeSnapshotManifest(malformed, await keyFor(malformed), "tickets", 41),
    );

    const canonical = encodeSnapshotManifest(manifest());
    const truncated = canonical.slice(0, -1);
    await expectInvalidResponse(
      decodeSnapshotManifest(truncated, await keyFor(truncated), "tickets", 41),
    );

    const spaced = new TextEncoder().encode(
      new TextDecoder().decode(canonical).replace(":2", ": 2"),
    );
    await expectInvalidResponse(
      decodeSnapshotManifest(spaced, await keyFor(spaced), "tickets", 41),
    );

    const duplicate = new TextEncoder().encode(
      new TextDecoder()
        .decode(canonical)
        .replace('"schema_version":2', '"schema_version":2,"schema_version":2'),
    );
    await expectInvalidResponse(
      decodeSnapshotManifest(duplicate, await keyFor(duplicate), "tickets", 41),
    );

    const changed = canonical.slice();
    changed[changed.length - 2] = changed[changed.length - 2]! ^ 1;
    await expectInvalidResponse(
      decodeSnapshotManifest(changed, await keyFor(canonical), "tickets", 41),
    );
  });

  test("decodes one private byte snapshot when the caller mutates the input during hashing", async () => {
    const value = manifest();
    const bytes = encodeSnapshotManifest(value);
    const key = await keyFor(bytes);
    const pending = decodeSnapshotManifest(bytes, key, "tickets", 41);
    const originalKey = value.chunks[0]!.key;
    const marker = new TextEncoder().encode(originalKey);
    const offset = bytes.findIndex((_byte, index) =>
      marker.every((expected, markerIndex) => bytes[index + markerIndex] === expected),
    );
    expect(offset).toBeGreaterThanOrEqual(0);
    bytes[offset + originalKey.lastIndexOf("/") + 1] = "8".charCodeAt(0);

    await expect(pending).resolves.toEqual(value);
  });

  test("rejects an oversized body before allocating a private copy", async () => {
    const bytes = new Uint8Array(64 * 1024 + 1);
    let copied = false;
    Object.defineProperty(bytes, "slice", {
      value: () => {
        copied = true;
        throw new Error("oversized input must not be copied");
      },
    });
    const key = snapshotManifestKey(prefix, incarnation, "0".repeat(64));

    await expectInvalidResponse(decodeSnapshotManifest(bytes, key, "tickets", 41));
    expect(copied).toBe(false);
  });

  test("rejects invalid caller keys and manifests as InvalidConfig", () => {
    expect(() => snapshotManifestKey(prefix, incarnation, "A".repeat(64))).toThrowError(
      expect.objectContaining({ code: "InvalidConfig" }),
    );
    expect(() =>
      encodeSnapshotManifest({ ...manifest(), chunks: [descriptor({ first_id: "\ud800" })] }),
    ).toThrowError(expect.objectContaining({ code: "InvalidConfig" }));

    const symbolField = Object.assign(manifest(), { [Symbol("unknown")]: true });
    expect(() => encodeSnapshotManifest(symbolField)).toThrowError(
      expect.objectContaining({ code: "InvalidConfig" }),
    );

    expect(() =>
      encodeSnapshotManifest(
        manifest({
          chunks: [
            descriptor({ first_id: "a", last_id: "b" }),
            descriptor({
              first_id: "c",
              last_id: "d",
              key: fixedChunkKey.replace(prefix, "app/other"),
            }),
          ],
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: "InvalidConfig" }));
  });
});

const idArb = fc.oneof(
  fc.stringMatching(/^[a-z][a-z0-9]{0,5}$/),
  fc.constantFrom("é", "e\u0301", "\u{10000}", "\u{1f600}"),
);

fcTest.prop({
  ids: fc.uniqueArray(idArb, { maxLength: 12 }),
  floor: fc.maxSafeNat(),
  seed: fc.nat(),
})("round-trips generated descriptors deterministically", async ({ ids, floor, seed }) => {
  const ordered = ids.toSorted(compareDocIds);
  const chunks = ordered.map((id, index) =>
    descriptor({
      first_id: id,
      last_id: id,
      key: `${prefix}/_v2/snapshot/chunks/${incarnation}/sha256/${(seed + index).toString(16).padStart(64, "0").slice(-64)}.json`,
      byte_length: 1 + ((seed + index) % 1_048_576),
      row_count: 1 + ((seed + index) % 4096),
    }),
  );
  const value = manifest({ log_seq_start: floor, chunks });
  const first = encodeSnapshotManifest(value);
  const second = encodeSnapshotManifest(value);
  expect(second).toEqual(first);
  const key = await keyFor(first);
  await expect(decodeSnapshotManifest(first, key, "tickets", floor)).resolves.toEqual(value);
});

fcTest.prop({ floor: fc.maxSafeNat() })(
  "changing only the incarnation changes canonical bytes and artifact keys",
  async ({ floor }) => {
    const first = encodeSnapshotManifest(manifest({ log_seq_start: floor, chunks: [] }));
    const second = encodeSnapshotManifest(
      manifest({ log_seq_start: floor, incarnation: otherIncarnation, chunks: [] }),
    );
    expect(first).not.toEqual(second);
    const firstKey = await keyFor(first);
    const secondKey = await keyFor(second, otherIncarnation);
    expect(firstKey).not.toBe(secondKey);
  },
);
