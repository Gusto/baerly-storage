import { BaerlyError, encodeJsonBytes, snapshotHash } from "@baerly/protocol";
import { describe, expect, test } from "vitest";
import { assertFailClosed } from "./testing.ts";
import {
  decodeSnapshotChunk,
  encodeSnapshotChunk,
  snapshotChunkKey,
  type SnapshotChunk,
} from "../snapshot-chunk.ts";
import type { SnapshotChunkDescriptor } from "../snapshot-manifest.ts";

const prefix = "app/demo/tenant/acme/manifests/tickets";
const incarnation = "00112233445566778899aabbccddeeff";

const chunk = (): SnapshotChunk => ({
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
});

const descriptorFor = async (
  bytes: Uint8Array,
  value: SnapshotChunk,
): Promise<SnapshotChunkDescriptor> => ({
  first_id: value.first_id,
  last_id: value.last_id,
  key: snapshotChunkKey(prefix, incarnation, await snapshotHash(bytes)),
  byte_length: bytes.byteLength,
  row_count: value.docs.length,
});

describe("assertFailClosed", () => {
  test("re-throws the original error on a clean InvalidResponse rejection", async () => {
    const value = chunk();
    const bytes = encodeJsonBytes({ ...value, schema_version: 99 });
    const descriptor = await descriptorFor(encodeSnapshotChunk(value), value);

    await expect(
      assertFailClosed(
        () => decodeSnapshotChunk(bytes, descriptor.key, "tickets", descriptor),
        "InvalidResponse",
      ),
    ).rejects.toMatchObject({ code: "InvalidResponse" });
  });

  test("fails when the operation succeeds instead of rejecting", async () => {
    const value = chunk();
    const bytes = encodeSnapshotChunk(value);
    const descriptor = await descriptorFor(bytes, value);

    await expect(
      assertFailClosed(
        () => decodeSnapshotChunk(bytes, descriptor.key, "tickets", descriptor),
        "InvalidResponse",
      ),
    ).rejects.toThrow("expected InvalidResponse but operation succeeded");
  });

  test("fails when the error carries the wrong code", async () => {
    await expect(
      assertFailClosed(() => {
        throw new BaerlyError("NetworkError", "network failure");
      }, "InvalidResponse"),
    ).rejects.toThrow("expected code InvalidResponse but got NetworkError");
  });

  test("fails when a non-BaerlyError is thrown", async () => {
    await expect(
      assertFailClosed(() => {
        throw new Error("plain error");
      }, "InvalidResponse"),
    ).rejects.toThrow("expected BaerlyError with code InvalidResponse");
  });
});
