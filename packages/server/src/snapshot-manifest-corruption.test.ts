import { snapshotHash } from "@baerly/protocol";
import { describe, expect, test } from "vitest";
import {
  corruptNumber,
  corruptUtf8,
  duplicateBytes,
  flipByte,
  swapBytes,
  truncateBytes,
} from "./corruption-test-helpers.ts";
import { assertFailClosed } from "./_internal/testing.ts";
import {
  decodeSnapshotManifest,
  encodeSnapshotManifest,
  snapshotManifestKey,
  type SnapshotChunkDescriptor,
  type SnapshotManifest,
} from "./snapshot-manifest.ts";

/**
 * Systematic byte-level corruption coverage for `decodeSnapshotManifest`,
 * complementing the field-level cases in `snapshot-manifest.test.ts`. Every
 * test drives a mutation primitive from `corruption-test-helpers.ts` (or a
 * targeted text splice standing in for one) through `assertFailClosed` to
 * prove the codec rejects with `InvalidResponse` before any corrupted field
 * becomes authority.
 */

const prefix = "app/demo/tenant/acme/manifests/tickets";
const incarnation = "00112233445566778899aabbccddeeff";
const fixedChunkKey = `${prefix}/_v2/snapshot/chunks/${incarnation}/sha256/96ae5ba511993addb97ba19c51004528a6cb5c278610352eb4478f4436a4315a.json`;

const descriptor = (overrides: Partial<SnapshotChunkDescriptor> = {}): SnapshotChunkDescriptor => ({
  first_id: "a",
  last_id: "c",
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

const REFERENCE = manifest();
const REFERENCE_BYTES = encodeSnapshotManifest(REFERENCE);
const REFERENCE_TEXT = new TextDecoder().decode(REFERENCE_BYTES);
const textBytes = (text: string): Uint8Array => new TextEncoder().encode(text);

function offsetOf(needle: string): number {
  const index = REFERENCE_TEXT.indexOf(needle);
  if (index === -1) {
    throw new Error(`fixture marker not found in reference manifest: ${JSON.stringify(needle)}`);
  }
  return index;
}

const SCHEMA_VALUE_BYTE = offsetOf('"schema_version":') + '"schema_version":'.length;
const LOG_SEQ_START_VALUE_BYTE = offsetOf('"log_seq_start":') + '"log_seq_start":'.length;
const INCARNATION_VALUE_BYTE = offsetOf(incarnation);
const COLLATION_VALUE_BYTE = offsetOf("utf8-scalar-v1");
const CHUNKS_ARRAY_BYTE = offsetOf('"chunks":[') + '"chunks":'.length;
const CLOSING_BRACE_BYTE = REFERENCE_BYTES.byteLength - 1;
const BYTE_LENGTH_VALUE_BYTE = offsetOf('"byte_length":') + '"byte_length":'.length;

const keyFor = async (bytes: Uint8Array, bodyIncarnation = incarnation): Promise<string> =>
  snapshotManifestKey(prefix, bodyIncarnation, await snapshotHash(bytes));

async function assertRejectsAgainst(key: string, bytes: Uint8Array): Promise<void> {
  await expect(
    assertFailClosed(() => decodeSnapshotManifest(bytes, key, "tickets", 41), "InvalidResponse"),
  ).rejects.toMatchObject({ code: "InvalidResponse" });
}

/**
 * Asserts that corrupted manifest `bytes` are rejected when the key is
 * rebuilt from those same corrupted bytes. The digest then agrees with the
 * body, so the failure lands past that check: in JSON parsing,
 * canonicalization, body-vs-key agreement, or field validation.
 * Keying against the *original* digest instead would trip the digest check
 * first and make every row assert the same branch — that case has its own
 * test below.
 */
async function assertRejectsSelfConsistent(bytes: Uint8Array): Promise<void> {
  await assertRejectsAgainst(await keyFor(bytes), bytes);
}

describe("snapshot manifest corruption: truncation", () => {
  // One offset per structural class — an empty body, a cut inside a scalar,
  // a cut inside the chunks array, and an unterminated object. Extra offsets
  // within a class land in the same rejection branch.
  test.each<[string, number]>([
    ["at byte 0 (empty body)", 0],
    ["mid incarnation value", INCARNATION_VALUE_BYTE + 4],
    ["at the chunks array", CHUNKS_ARRAY_BYTE],
    ["dropping the closing brace", CLOSING_BRACE_BYTE],
  ])("rejects a body truncated %s", async (_label, at) => {
    await assertRejectsSelfConsistent(truncateBytes(REFERENCE_BYTES, at));
  });
});

describe("snapshot manifest corruption: bit flips", () => {
  test.each<[string, number]>([
    ["the schema_version digit", SCHEMA_VALUE_BYTE],
    ["the log_seq_start digit", LOG_SEQ_START_VALUE_BYTE],
    ["an incarnation hex digit", INCARNATION_VALUE_BYTE],
    ["the collation value", COLLATION_VALUE_BYTE],
  ])("rejects a bit flip in %s", async (_label, at) => {
    await assertRejectsSelfConsistent(flipByte(REFERENCE_BYTES, at));
  });
});

describe("snapshot manifest corruption: byte corruption", () => {
  test("rejects number corruption in log_seq_start", async () => {
    await assertRejectsSelfConsistent(corruptNumber(REFERENCE_BYTES, LOG_SEQ_START_VALUE_BYTE));
  });

  test("rejects UTF-8 corruption inside a multi-byte descriptor ID", async () => {
    const value = manifest({ chunks: [descriptor({ first_id: "a", last_id: "é" })] });
    const bytes = encodeSnapshotManifest(value);
    await assertRejectsSelfConsistent(corruptUtf8(bytes, 0));
  });

  test("rejects a byte swap at a structurally significant position", async () => {
    await assertRejectsSelfConsistent(
      swapBytes(REFERENCE_BYTES, SCHEMA_VALUE_BYTE, CHUNKS_ARRAY_BYTE),
    );
  });
});

describe("snapshot manifest corruption: malformed structure", () => {
  test("rejects a duplicated envelope field", async () => {
    const fieldText = '"schema_version":2,';
    const corrupted = duplicateBytes(REFERENCE_BYTES, offsetOf(fieldText), fieldText.length);
    await assertRejectsSelfConsistent(corrupted);
  });

  test("rejects an unknown envelope field spliced in", async () => {
    await assertRejectsSelfConsistent(
      textBytes(
        REFERENCE_TEXT.replace('"schema_version":2,', '"schema_version":2,"surprise":true,'),
      ),
    );
  });

  test("rejects a missing required field", async () => {
    await assertRejectsSelfConsistent(
      textBytes(REFERENCE_TEXT.replace(',"collation":"utf8-scalar-v1"', "")),
    );
  });

  test("rejects non-canonical whitespace", async () => {
    await assertRejectsSelfConsistent(
      textBytes(REFERENCE_TEXT.replace('"schema_version":2', '"schema_version": 2')),
    );
  });
});

describe("snapshot manifest corruption: unauthenticated inputs", () => {
  test("rejects a digest mismatch even when the corrupted body stays syntactically valid", async () => {
    const key = await keyFor(REFERENCE_BYTES);
    const corrupted = flipByte(REFERENCE_BYTES, BYTE_LENGTH_VALUE_BYTE);
    await assertRejectsAgainst(key, corrupted);
  });

  test.each<[string, (key: string) => string]>([
    ["a wrong incarnation", (key) => key.replace(incarnation, incarnation.replace("00", "ff"))],
    ["a wrong version segment", (key) => key.replace("/_v2/", "/_v3/")],
    ["a wrong artifact kind", (key) => key.replace("/manifests/", "/chunks/")],
    ["a wrong hash algorithm", (key) => key.replace("/sha256/", "/sha1/")],
    ["an uppercase digest", (key) => key.replace(/[a-f](?=[0-9a-f]{0,63}\.json$)/, "A")],
    ["a short digest", (key) => key.replace(/[0-9a-f]\.json$/, ".json")],
  ])("rejects a key with %s", async (_label, corrupt) => {
    const key = await keyFor(REFERENCE_BYTES);
    await assertRejectsAgainst(corrupt(key), REFERENCE_BYTES);
  });
});
