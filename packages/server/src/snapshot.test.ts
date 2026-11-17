import {
  encodeJsonBytes,
  MemoryStorage,
  snapshotHash,
  SNAPSHOT_SCHEMA_VERSION,
} from "@baerly/protocol";
import { describe, expect, test } from "vitest";
import { loadSnapshotAsMap, snapshotKey } from "./snapshot.ts";

const putSnapshot = async (s: MemoryStorage, schemaVersion: unknown): Promise<string> => {
  const body = encodeJsonBytes({
    schema_version: schemaVersion,
    min_seq: 0,
    max_seq: 1,
    collection: "c",
    docs: [],
  });
  const key = snapshotKey("c", 0, 1, await snapshotHash(body));
  await s.put(key, body, { contentType: "application/json" });
  return key;
};

describe("loadSnapshotAsMap — schema_version refusal", () => {
  test.each([
    ["newer", SNAPSHOT_SCHEMA_VERSION + 1],
    ["non-integer", 1.5],
    ["pre-0.3", 0],
  ])("%s version message names both versions, no bucket advice", async (_n, v) => {
    const s = new MemoryStorage();
    const key = await putSnapshot(s, v);
    const err = await loadSnapshotAsMap(s, key, "c").catch((error: unknown) => error);
    expect(err).toMatchObject({ code: "InvalidResponse" });
    const msg = (err as Error).message;
    expect(msg).toContain(String(v));
    expect(msg).toContain(String(SNAPSHOT_SCHEMA_VERSION));
    expect(msg).not.toMatch(/recreate|bucket/i);
    if (v === SNAPSHOT_SCHEMA_VERSION + 1) {
      expect(msg).toMatch(/newer baerly-storage release/);
    }
  });
});
