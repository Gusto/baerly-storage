import { snapshotHash } from "@baerly/protocol";
import { describe, expect, test } from "vitest";
import {
  corruptJsonEscape,
  corruptNumber,
  corruptUtf8,
  duplicateBytes,
  flipByte,
  insertByte,
  swapBytes,
  truncateBytes,
} from "./corruption-test-helpers.ts";
import { assertFailClosed } from "./snapshot-codec.ts";
import {
  decodeSnapshotChunk,
  encodeSnapshotChunk,
  snapshotChunkKey,
  type SnapshotChunk,
} from "./snapshot-chunk.ts";
import type { SnapshotChunkDescriptor } from "./snapshot-manifest.ts";

/**
 * Systematic byte-level corruption coverage for `decodeSnapshotChunk`,
 * complementing the field-level cases in `snapshot-chunk.test.ts`. Every
 * test drives a mutation primitive from `corruption-test-helpers.ts`
 * through `assertFailClosed` to prove the codec rejects with
 * `InvalidResponse` before any corrupted field becomes authority, and that
 * the rejection message doesn't leak a validated value.
 */

const prefix = "app/demo/tenant/acme/manifests/tickets";
const incarnation = "00112233445566778899aabbccddeeff";

const chunk = (overrides: Partial<SnapshotChunk> = {}): SnapshotChunk => ({
  schema_version: 2,
  collection: "tickets",
  incarnation,
  first_id: "a",
  last_id: "c",
  docs: [
    { _id: "a", value: 1 },
    { _id: "b", value: 2 },
    { _id: "c", value: 3 },
  ],
  ...overrides,
});

const REFERENCE = chunk();
const REFERENCE_BYTES = encodeSnapshotChunk(REFERENCE);
const REFERENCE_TEXT = new TextDecoder().decode(REFERENCE_BYTES);

function offsetOf(needle: string): number {
  const index = REFERENCE_TEXT.indexOf(needle);
  if (index === -1) {
    throw new Error(`fixture marker not found in reference chunk: ${JSON.stringify(needle)}`);
  }
  return index;
}

const SCHEMA_VALUE_BYTE = offsetOf('"schema_version":') + '"schema_version":'.length;
const COLLECTION_FIELD_BYTE = offsetOf('"collection":');
const INCARNATION_FIELD_BYTE = offsetOf('"incarnation":');
const INCARNATION_VALUE_BYTE = offsetOf(incarnation);
const DOCS_ARRAY_BYTE = offsetOf('"docs":[') + '"docs":'.length;
const CLOSING_BRACE_BYTE = REFERENCE_BYTES.byteLength - 1;
const FIRST_ID_VALUE_BYTE = offsetOf('"first_id":"') + '"first_id":"'.length;
const LAST_ID_VALUE_BYTE = offsetOf('"last_id":"') + '"last_id":"'.length;

const descriptorFor = async (
  bytes: Uint8Array,
  value: SnapshotChunk,
  overrides: Partial<SnapshotChunkDescriptor> = {},
): Promise<SnapshotChunkDescriptor> => ({
  first_id: value.first_id,
  last_id: value.last_id,
  key: snapshotChunkKey(prefix, value.incarnation, await snapshotHash(bytes)),
  byte_length: bytes.byteLength,
  row_count: value.docs.length,
  ...overrides,
});

const referenceDescriptor = (): Promise<SnapshotChunkDescriptor> =>
  descriptorFor(REFERENCE_BYTES, REFERENCE);

async function assertRejectsAgainst(
  descriptor: SnapshotChunkDescriptor,
  bytes: Uint8Array,
): Promise<void> {
  await expect(
    assertFailClosed(
      () => decodeSnapshotChunk(bytes, descriptor.key, "tickets", descriptor),
      "InvalidResponse",
    ),
  ).rejects.toMatchObject({ code: "InvalidResponse" });
}

/**
 * Asserts that `bytes` — some corruption of `REFERENCE_BYTES` — is rejected
 * against the *original* descriptor/key, i.e. the manifest still expects
 * the uncorrupted body. Any byte-level corruption changes the digest, so
 * this always fails no later than the descriptor/digest checks regardless
 * of whether the corrupted bytes happen to still parse as JSON.
 */
async function assertRejectsCorruptedBody(bytes: Uint8Array): Promise<void> {
  await assertRejectsAgainst(await referenceDescriptor(), bytes);
}

describe("snapshot chunk corruption: truncation", () => {
  test.each<[string, number]>([
    ["at byte 0 (empty body)", 0],
    ["mid schema_version value", SCHEMA_VALUE_BYTE],
    ["at the collection field", COLLECTION_FIELD_BYTE],
    ["at the incarnation field", INCARNATION_FIELD_BYTE],
    ["mid incarnation value", INCARNATION_VALUE_BYTE + 4],
    ["at the docs array", DOCS_ARRAY_BYTE],
    ["dropping the closing brace", CLOSING_BRACE_BYTE],
    ["dropping the last two bytes", REFERENCE_BYTES.byteLength - 2],
  ])("rejects a body truncated %s", async (_label, at) => {
    await assertRejectsCorruptedBody(truncateBytes(REFERENCE_BYTES, at));
  });

  test("rejects truncation at every 10th byte position", async () => {
    for (let at = 10; at < REFERENCE_BYTES.byteLength; at += 10) {
      await assertRejectsCorruptedBody(truncateBytes(REFERENCE_BYTES, at));
    }
  });
});

describe("snapshot chunk corruption: bit flips", () => {
  test.each<[string, number]>([
    ["the schema_version digit", SCHEMA_VALUE_BYTE],
    ["an incarnation hex digit", INCARNATION_VALUE_BYTE],
    ["the first_id value", FIRST_ID_VALUE_BYTE],
    ["the last_id value", LAST_ID_VALUE_BYTE],
  ])("rejects a bit flip in %s", async (_label, at) => {
    await assertRejectsCorruptedBody(flipByte(REFERENCE_BYTES, at));
  });

  test("rejects a bit flip at every 16th byte position", async () => {
    for (let at = 0; at < REFERENCE_BYTES.byteLength; at += 16) {
      await assertRejectsCorruptedBody(flipByte(REFERENCE_BYTES, at));
    }
  });
});

describe("snapshot chunk corruption: byte corruption", () => {
  test("rejects UTF-8 corruption inside a multi-byte document ID", async () => {
    const value = chunk({
      first_id: "a",
      last_id: "é",
      docs: [
        { _id: "a", value: 1 },
        { _id: "é", value: 2 },
      ],
    });
    const bytes = encodeSnapshotChunk(value);
    const descriptor = await descriptorFor(bytes, value);
    await assertRejectsAgainst(descriptor, corruptUtf8(bytes, 0));
  });

  test("rejects JSON escape corruption inside a document field", async () => {
    const value = chunk({
      first_id: "a",
      last_id: "a",
      docs: [{ _id: "a", note: "line\nbreak" }],
    });
    const bytes = encodeSnapshotChunk(value);
    const descriptor = await descriptorFor(bytes, value);
    await assertRejectsAgainst(descriptor, corruptJsonEscape(bytes, 0));
  });

  test("rejects number corruption in the schema_version field", async () => {
    await assertRejectsCorruptedBody(corruptNumber(REFERENCE_BYTES, 0));
  });

  test("rejects a byte swap at a structurally significant position", async () => {
    await assertRejectsCorruptedBody(
      swapBytes(REFERENCE_BYTES, SCHEMA_VALUE_BYTE, DOCS_ARRAY_BYTE),
    );
  });
});

describe("snapshot chunk corruption: overlapping ranges", () => {
  test.each<[string, Partial<SnapshotChunkDescriptor>]>([
    ["first_id", { first_id: "z" }],
    ["last_id", { last_id: "z" }],
    ["row_count", { row_count: 2 }],
    ["byte_length", { byte_length: 1 }],
  ])("rejects a descriptor %s mismatch", async (_label, override) => {
    const descriptor = await descriptorFor(REFERENCE_BYTES, REFERENCE, override);
    await assertRejectsAgainst(descriptor, REFERENCE_BYTES);
  });
});

describe("snapshot chunk corruption: malformed structure", () => {
  test("rejects a stray byte inserted before the docs array", async () => {
    const corrupted = insertByte(REFERENCE_BYTES, DOCS_ARRAY_BYTE, "x".charCodeAt(0));
    const descriptor = await descriptorFor(corrupted, REFERENCE);
    await assertRejectsAgainst(descriptor, corrupted);
  });

  test("rejects a duplicated collection field", async () => {
    const fieldText = '"collection":"tickets",';
    const at = offsetOf(fieldText);
    const corrupted = duplicateBytes(REFERENCE_BYTES, at, fieldText.length);
    const descriptor = await descriptorFor(corrupted, REFERENCE);
    await assertRejectsAgainst(descriptor, corrupted);
  });
});

describe("snapshot chunk corruption: unauthenticated inputs", () => {
  test("rejects a digest mismatch even when the corrupted body stays syntactically valid", async () => {
    const descriptor = await referenceDescriptor();
    const at = offsetOf('"value":1') + '"value":'.length;
    const corrupted = flipByte(REFERENCE_BYTES, at);
    await assertRejectsAgainst(descriptor, corrupted);
  });
});
