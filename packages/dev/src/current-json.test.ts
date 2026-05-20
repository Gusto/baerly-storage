import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CURRENT_JSON_SCHEMA_VERSION,
  type CurrentJson,
  casUpdateCurrentJson,
  createCurrentJson,
  readCurrentJson,
} from "@baerly/protocol";
import { claimWriter } from "../../protocol/src/coordination/current-json.ts";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { LocalFsStorage } from "./local-fs.ts";

/**
 * Single-process smoke for the current.json CAS protocol against the
 * directory-tree storage adapter. `LocalFsStorage` documents that
 * `ifMatch`/`ifNoneMatch` are NOT cross-process safe (see
 * `local-fs.ts` class JSDoc) — this file only covers the
 * single-process case where the in-process TOCTOU window is narrow
 * enough that the CAS protocol is observably correct. Multi-process
 * safety is delegated to S3 / R2 / Minio.
 */
describe("current.json on LocalFsStorage", () => {
  let root: string;
  let storage: LocalFsStorage;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "baerly-current-json-"));
    storage = new LocalFsStorage({ root });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const seed: CurrentJson = {
    schema_version: CURRENT_JSON_SCHEMA_VERSION,
    snapshot: null,
    next_seq: 0,
    log_seq_start: 0,
    writer_fence: { epoch: 0, owner: "", claimed_at: "" },
  };

  test("create + read + claim round-trip", async () => {
    await createCurrentJson(storage, "tenant/coll/current.json", seed);
    const r = await readCurrentJson(storage, "tenant/coll/current.json");
    expect(r!.json).toEqual(seed);
    const claimed = await claimWriter(storage, "tenant/coll/current.json", "worker-a");
    expect(claimed.json.writer_fence.epoch).toBe(1);
    expect(claimed.json.writer_fence.owner).toBe("worker-a");
    // LocalFsStorage surfaces serverDate, so claim_at is stamped.
    expect(claimed.json.writer_fence.claimed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("create-only guard rejects an existing key with Conflict", async () => {
    await createCurrentJson(storage, "k", seed);
    await expect(createCurrentJson(storage, "k", seed)).rejects.toMatchObject({
      code: "Conflict",
    });
  });

  test("stale-etag update surfaces as Conflict", async () => {
    // True multi-writer races on LocalFsStorage have a TOCTOU window
    // even within a single process — two `casUpdateCurrentJson`
    // calls that read the same etag can both pass the ifMatch guard
    // because the content-addressed etag depends only on the body
    // written. Cross-process CAS is delegated to S3/R2 (see
    // `local-fs.ts` class JSDoc). What we DO verify here is that
    // when the storage layer observes a stale etag, it surfaces
    // `Conflict` directly — no string-sentinel translation needed.
    await createCurrentJson(storage, "k", seed);
    // Stage a stale read by snapshotting etag, then landing a
    // separate update that bumps it.
    const stale = await readCurrentJson(storage, "k");
    expect(stale).not.toBeNull();
    await casUpdateCurrentJson(storage, "k", (c) => ({ ...c, next_seq: c.next_seq + 1 }));
    await expect(
      storage.put("k", new TextEncoder().encode(JSON.stringify({ ...seed, next_seq: 999 })), {
        ifMatch: stale!.etag,
        contentType: "application/json",
      }),
    ).rejects.toMatchObject({ code: "Conflict" });
  });
});
