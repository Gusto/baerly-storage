import { snapshotHash } from "@baerly/protocol";
import { describe, expect, test } from "vitest";
import {
  corruptNumber,
  corruptUtf8,
  duplicateBytes,
  flipByte,
  insertByte,
  swapBytes,
  truncateBytes,
} from "./corruption-test-helpers.ts";
import { assertFailClosed } from "./_internal/testing.ts";
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
 * `InvalidResponse` before any corrupted field becomes authority.
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
 * when the descriptor is rebuilt from the corrupted bytes themselves. The
 * digest and `byte_length` then agree with the body, so the failure lands
 * past those checks: in JSON parsing, canonicalization, body-vs-key
 * agreement, or body-vs-descriptor field agreement. Keying against the
 * *original* descriptor instead would trip the digest check first and make
 * every row assert the same branch — that case has its own test below.
 */
async function assertRejectsSelfConsistent(bytes: Uint8Array): Promise<void> {
  await assertRejectsAgainst(await descriptorFor(bytes, REFERENCE), bytes);
}

describe("snapshot chunk corruption: truncation", () => {
  // One offset per structural class — an empty body, a cut inside a scalar,
  // a cut inside the docs array, and an unterminated object. Extra offsets
  // within a class land in the same rejection branch.
  test.each<[string, number]>([
    ["at byte 0 (empty body)", 0],
    ["mid incarnation value", INCARNATION_VALUE_BYTE + 4],
    ["at the docs array", DOCS_ARRAY_BYTE],
    ["dropping the closing brace", CLOSING_BRACE_BYTE],
  ])("rejects a body truncated %s", async (_label, at) => {
    await assertRejectsSelfConsistent(truncateBytes(REFERENCE_BYTES, at));
  });
});

describe("snapshot chunk corruption: bit flips", () => {
  test.each<[string, number]>([
    ["the schema_version digit", SCHEMA_VALUE_BYTE],
    ["an incarnation hex digit", INCARNATION_VALUE_BYTE],
    ["the first_id value", FIRST_ID_VALUE_BYTE],
    ["the last_id value", LAST_ID_VALUE_BYTE],
  ])("rejects a bit flip in %s", async (_label, at) => {
    await assertRejectsSelfConsistent(flipByte(REFERENCE_BYTES, at));
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
    const corrupted = corruptUtf8(bytes, 0);
    // Re-key descriptor to corrupted bytes so digest matches, exercising JSON parser
    const descriptor = await descriptorFor(corrupted, value);
    await assertRejectsAgainst(descriptor, corrupted);
  });

  test("rejects number corruption in the schema_version field", async () => {
    await assertRejectsSelfConsistent(corruptNumber(REFERENCE_BYTES, 0));
  });

  test("rejects a byte swap at a structurally significant position", async () => {
    await assertRejectsSelfConsistent(
      swapBytes(REFERENCE_BYTES, SCHEMA_VALUE_BYTE, DOCS_ARRAY_BYTE),
    );
  });
});

describe("snapshot chunk corruption: malformed structure", () => {
  test("rejects a stray byte inserted before the docs array", async () => {
    await assertRejectsSelfConsistent(
      insertByte(REFERENCE_BYTES, DOCS_ARRAY_BYTE, "x".charCodeAt(0)),
    );
  });

  test("rejects a duplicated collection field", async () => {
    const fieldText = '"collection":"tickets",';
    await assertRejectsSelfConsistent(
      duplicateBytes(REFERENCE_BYTES, offsetOf(fieldText), fieldText.length),
    );
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
