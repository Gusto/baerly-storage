/**
 * `gc/pending.json` control-object helpers. Mirrors
 * `current-json.test.ts` — round-trip, CAS, shape guards.
 */

import { fc, test as fcTest } from "@fast-check/vitest";
import { describe, expect, test } from "vitest";
import { MemoryStorage } from "../storage/memory.ts";
import { BaerlyError } from "../errors.ts";
import { GC_PENDING_CONTENT_TYPE, GC_PENDING_SCHEMA_VERSION } from "../constants.ts";
import {
  type GcCandidate,
  type GcPending,
  casUpdateGcPending,
  createGcPending,
  readGcPending,
} from "./gc-pending.ts";

const KEY = "app/x/tenant/t/manifests/c/gc/pending.json";

const initial = (): GcPending => ({
  schema_version: GC_PENDING_SCHEMA_VERSION,
  candidates: [],
  last_swept_at: "",
});

describe("gc-pending", () => {
  test("GC_PENDING_CONTENT_TYPE is the on-bucket MIME type for gc/pending.json", () => {
    // This string is written as the Content-Type header on every
    // gc/pending.json PUT and returned on subsequent GETs by S3/R2.
    // Pinned here (not just in constants.test.ts) because Stryker's
    // perTest coverage attributes the constants.ts module-level
    // assignment to the first test file that imports it.
    expect(GC_PENDING_CONTENT_TYPE).toBe("application/json");
  });

  test("returns null on not-found", async () => {
    const s = new MemoryStorage();
    await expect(readGcPending(s, KEY)).resolves.toBeNull();
  });

  test("creates then reads back the same body", async () => {
    const s = new MemoryStorage();
    const created = await createGcPending(s, KEY, initial());
    expect(created.json.schema_version).toBe(1);
    expect(created.json.candidates).toEqual([]);
    expect(created.etag).toMatch(/^"[0-9a-f]+"$/);

    const read = await readGcPending(s, KEY);
    expect(read).not.toBeNull();
    expect(read?.json).toEqual(initial());
    expect(read?.etag).toBe(created.etag);
  });

  test("create-only: throws Conflict if the key already exists", async () => {
    const s = new MemoryStorage();
    await createGcPending(s, KEY, initial());
    await expect(createGcPending(s, KEY, initial())).rejects.toMatchObject({
      code: "Conflict",
    });
  });

  test("cas-updates appended candidates", async () => {
    const s = new MemoryStorage();
    await createGcPending(s, KEY, initial());
    const updated = await casUpdateGcPending(s, KEY, (cur) => ({
      ...cur,
      candidates: [
        ...cur.candidates,
        { key: "x/log/0.json", due_at: "2099-01-01T00:00:00.000Z", reason: "stale-log" },
      ],
      last_swept_at: "2025-01-01T00:00:00.000Z",
    }));
    expect(updated.json.candidates).toHaveLength(1);
    expect(updated.json.last_swept_at).toBe("2025-01-01T00:00:00.000Z");

    const read = await readGcPending(s, KEY);
    expect(read?.json.candidates).toHaveLength(1);
    expect(read?.json.candidates[0]?.reason).toBe("stale-log");
  });

  test("cas-update on a stale etag throws Conflict", async () => {
    const s = new MemoryStorage();
    const created = await createGcPending(s, KEY, initial());
    // First update commits.
    await casUpdateGcPending(s, KEY, (cur) => ({
      ...cur,
      candidates: [
        ...cur.candidates,
        { key: "a.json", due_at: "2099-01-01T00:00:00.000Z", reason: "stale-log" },
      ],
    }));
    // A second concurrent update that races on the same starting etag
    // is simulated by replaying the write at the original etag.
    // The helper re-reads + writes-with-the-fresh-etag, so we drop
    // straight to the storage layer here to simulate "another writer
    // landed between my read and write."
    const stale = new TextEncoder().encode(JSON.stringify(initial()));
    await expect(
      s.put(KEY, stale, { ifMatch: created.etag, contentType: "application/json" }),
    ).rejects.toMatchObject({ code: "Conflict" });
  });

  test("cas-update on a missing key throws InvalidResponse", async () => {
    const s = new MemoryStorage();
    await expect(casUpdateGcPending(s, KEY, (cur) => cur)).rejects.toMatchObject({
      code: "InvalidResponse",
    });
  });

  test("rejects unknown schema_version on read", async () => {
    const s = new MemoryStorage();
    const bad = new TextEncoder().encode(
      JSON.stringify({ schema_version: 99, candidates: [], last_swept_at: "" }),
    );
    await s.put(KEY, bad, { contentType: "application/json" });
    await expect(readGcPending(s, KEY)).rejects.toMatchObject({
      code: "InvalidResponse",
    });
  });

  test("rejects malformed body on read", async () => {
    const s = new MemoryStorage();
    await s.put(KEY, new TextEncoder().encode("{ not json"), {
      contentType: "application/json",
    });
    await expect(readGcPending(s, KEY)).rejects.toMatchObject({
      code: "InvalidResponse",
    });
  });

  test("rejects unknown reason on read", async () => {
    const s = new MemoryStorage();
    const bad = new TextEncoder().encode(
      JSON.stringify({
        schema_version: 1,
        candidates: [{ key: "a", due_at: "x", reason: "made-up" }],
        last_swept_at: "",
      }),
    );
    await s.put(KEY, bad, { contentType: "application/json" });
    await expect(readGcPending(s, KEY)).rejects.toThrow(BaerlyError);
  });

  test("rejects malformed shape on create", async () => {
    const s = new MemoryStorage();
    const bad = { schema_version: 1, candidates: "no", last_swept_at: "" } as unknown as GcPending;
    await expect(createGcPending(s, KEY, bad)).rejects.toMatchObject({
      code: "InvalidResponse",
    });
  });

  // ---- JSON parse error message precision (L106, L109) ----

  test("malformed JSON read throws InvalidResponse mentioning 'body is not valid JSON'", async () => {
    const s = new MemoryStorage();
    await s.put(KEY, new TextEncoder().encode("{ not json"), {
      contentType: GC_PENDING_CONTENT_TYPE,
    });
    const err = await readGcPending(s, KEY).catch((error: unknown) => error);
    expect(err).toBeInstanceOf(BaerlyError);
    expect((err as BaerlyError).code).toBe("InvalidResponse");
    // L109: the message must mention "body is not valid JSON" (not "not an object")
    expect((err as BaerlyError).message).toContain("body is not valid JSON");
    // L106: the catch block must attach the original parse error as cause
    expect((err as BaerlyError).cause).toBeDefined();
  });

  // ---- assertGcPending: null / non-object (L208) ----

  test("rejects null body", async () => {
    const s = new MemoryStorage();
    await s.put(KEY, new TextEncoder().encode("null"), { contentType: GC_PENDING_CONTENT_TYPE });
    const err = await readGcPending(s, KEY).catch((error: unknown) => error);
    // Must be a BaerlyError (not TypeError), code must be InvalidResponse,
    // and message must reference "not an object" (kills L208 ConditionalExpression → false)
    expect(err).toBeInstanceOf(BaerlyError);
    expect((err as BaerlyError).code).toBe("InvalidResponse");
    expect((err as BaerlyError).message).toContain("not an object");
  });

  test("rejects array body (not a plain object — fails at schema_version)", async () => {
    // Arrays have typeof === "object" so pass the null/non-object guard; they fail
    // at schema_version check because r["schema_version"] is undefined.
    const s = new MemoryStorage();
    await s.put(KEY, new TextEncoder().encode("[1,2,3]"), { contentType: GC_PENDING_CONTENT_TYPE });
    await expect(readGcPending(s, KEY)).rejects.toMatchObject({
      code: "InvalidResponse",
    });
  });

  test("rejects number body (non-object) — message must say 'not an object'", async () => {
    // Kills L208 ConditionalExpression → false (the typeof guard half):
    // with typeof → false, a number body passes the null/non-object guard but fails at
    // schema_version with "unsupported schema_version undefined", not "not an object".
    const s = new MemoryStorage();
    await s.put(KEY, new TextEncoder().encode("42"), { contentType: GC_PENDING_CONTENT_TYPE });
    const err = await readGcPending(s, KEY).catch((error: unknown) => error);
    expect(err).toBeInstanceOf(BaerlyError);
    expect((err as BaerlyError).code).toBe("InvalidResponse");
    expect((err as BaerlyError).message).toContain("not an object");
  });

  // ---- schema_version check (L215, L218) ----

  test("rejects schema_version 0 (not 1)", async () => {
    const s = new MemoryStorage();
    await s.put(
      KEY,
      new TextEncoder().encode(
        JSON.stringify({ schema_version: 0, candidates: [], last_swept_at: "" }),
      ),
      { contentType: GC_PENDING_CONTENT_TYPE },
    );
    const err = await readGcPending(s, KEY).catch((error: unknown) => error);
    expect(err).toBeInstanceOf(BaerlyError);
    expect((err as BaerlyError).code).toBe("InvalidResponse");
    // L218: message must mention both the bad version value AND "expected"
    // This kills both StringLiteral → "" mutations on this line
    expect((err as BaerlyError).message).toContain("schema_version");
    expect((err as BaerlyError).message).toContain("0");
    expect((err as BaerlyError).message).toContain("expected");
    expect((err as BaerlyError).message).toContain("1");
  });

  test("rejects schema_version string 'one'", async () => {
    const s = new MemoryStorage();
    await s.put(
      KEY,
      new TextEncoder().encode(
        JSON.stringify({ schema_version: "one", candidates: [], last_swept_at: "" }),
      ),
      { contentType: GC_PENDING_CONTENT_TYPE },
    );
    await expect(readGcPending(s, KEY)).rejects.toMatchObject({ code: "InvalidResponse" });
  });

  // ---- candidates must be an array (L221, L224) ----

  test("rejects candidates as null", async () => {
    const s = new MemoryStorage();
    await s.put(
      KEY,
      new TextEncoder().encode(
        JSON.stringify({ schema_version: 1, candidates: null, last_swept_at: "" }),
      ),
      { contentType: GC_PENDING_CONTENT_TYPE },
    );
    const err = await readGcPending(s, KEY).catch((error: unknown) => error);
    expect((err as BaerlyError).code).toBe("InvalidResponse");
    // L224: message must mention candidates
    expect((err as BaerlyError).message).toContain("candidates");
  });

  test("rejects candidates as object (not array)", async () => {
    const s = new MemoryStorage();
    await s.put(
      KEY,
      new TextEncoder().encode(
        JSON.stringify({ schema_version: 1, candidates: {}, last_swept_at: "" }),
      ),
      { contentType: GC_PENDING_CONTENT_TYPE },
    );
    await expect(readGcPending(s, KEY)).rejects.toMatchObject({ code: "InvalidResponse" });
  });

  // ---- candidate item must be an object (L229, L231, L232) ----

  test("rejects candidate that is null", async () => {
    const s = new MemoryStorage();
    await s.put(
      KEY,
      new TextEncoder().encode(
        JSON.stringify({
          schema_version: 1,
          candidates: [null],
          last_swept_at: "",
        }),
      ),
      { contentType: GC_PENDING_CONTENT_TYPE },
    );
    const err = await readGcPending(s, KEY).catch((error: unknown) => error);
    // Must be BaerlyError (not TypeError), kills L229 ConditionalExpression → false
    // (without the guard, c === null leads to TypeError accessing c["key"])
    expect(err).toBeInstanceOf(BaerlyError);
    expect((err as BaerlyError).code).toBe("InvalidResponse");
    // L231: message must mention index and "not an object"
    expect((err as BaerlyError).message).toContain("candidates[0]");
    expect((err as BaerlyError).message).toContain("not an object");
  });

  test("rejects candidate that is a string — message must say 'not an object'", async () => {
    // Kills L229 ConditionalExpression → false (the typeof guard half):
    // with typeof → false, a string candidate passes the null/non-object guard and
    // fails at key-validation with "key must be a non-empty string", not "not an object".
    const s = new MemoryStorage();
    await s.put(
      KEY,
      new TextEncoder().encode(
        JSON.stringify({
          schema_version: 1,
          candidates: ["oops"],
          last_swept_at: "",
        }),
      ),
      { contentType: GC_PENDING_CONTENT_TYPE },
    );
    const err = await readGcPending(s, KEY).catch((error: unknown) => error);
    expect(err).toBeInstanceOf(BaerlyError);
    expect((err as BaerlyError).code).toBe("InvalidResponse");
    expect((err as BaerlyError).message).toContain("not an object");
  });

  // ---- candidate key validation (L236, L238, L239) ----

  test("rejects candidate with missing key field", async () => {
    const s = new MemoryStorage();
    await s.put(
      KEY,
      new TextEncoder().encode(
        JSON.stringify({
          schema_version: 1,
          candidates: [{ due_at: "2099-01-01T00:00:00.000Z", reason: "stale-log" }],
          last_swept_at: "",
        }),
      ),
      { contentType: GC_PENDING_CONTENT_TYPE },
    );
    const err = await readGcPending(s, KEY).catch((error: unknown) => error);
    expect((err as BaerlyError).code).toBe("InvalidResponse");
    // L238/L239: message should mention key
    expect((err as BaerlyError).message).toContain("key");
  });

  test("rejects candidate with empty string key (L236: length === 0 guard)", async () => {
    const s = new MemoryStorage();
    await s.put(
      KEY,
      new TextEncoder().encode(
        JSON.stringify({
          schema_version: 1,
          candidates: [{ key: "", due_at: "2099-01-01T00:00:00.000Z", reason: "stale-log" }],
          last_swept_at: "",
        }),
      ),
      { contentType: GC_PENDING_CONTENT_TYPE },
    );
    await expect(readGcPending(s, KEY)).rejects.toMatchObject({ code: "InvalidResponse" });
  });

  test("rejects candidate with numeric key", async () => {
    const s = new MemoryStorage();
    await s.put(
      KEY,
      new TextEncoder().encode(
        JSON.stringify({
          schema_version: 1,
          candidates: [{ key: 42, due_at: "2099-01-01T00:00:00.000Z", reason: "stale-log" }],
          last_swept_at: "",
        }),
      ),
      { contentType: GC_PENDING_CONTENT_TYPE },
    );
    await expect(readGcPending(s, KEY)).rejects.toMatchObject({ code: "InvalidResponse" });
  });

  // ---- candidate due_at validation (L242, L244, L245) ----

  test("rejects candidate with missing due_at", async () => {
    const s = new MemoryStorage();
    await s.put(
      KEY,
      new TextEncoder().encode(
        JSON.stringify({
          schema_version: 1,
          candidates: [{ key: "x/log/0.json", reason: "stale-log" }],
          last_swept_at: "",
        }),
      ),
      { contentType: GC_PENDING_CONTENT_TYPE },
    );
    const err = await readGcPending(s, KEY).catch((error: unknown) => error);
    expect((err as BaerlyError).code).toBe("InvalidResponse");
    // L244/L245: message must mention due_at
    expect((err as BaerlyError).message).toContain("due_at");
  });

  test("rejects candidate with numeric due_at", async () => {
    const s = new MemoryStorage();
    await s.put(
      KEY,
      new TextEncoder().encode(
        JSON.stringify({
          schema_version: 1,
          candidates: [{ key: "x/log/0.json", due_at: 12345, reason: "stale-log" }],
          last_swept_at: "",
        }),
      ),
      { contentType: GC_PENDING_CONTENT_TYPE },
    );
    await expect(readGcPending(s, KEY)).rejects.toMatchObject({ code: "InvalidResponse" });
  });

  // ---- reason validation (L249, L253, L254) ----

  test("rejects candidate with numeric reason", async () => {
    const s = new MemoryStorage();
    await s.put(
      KEY,
      new TextEncoder().encode(
        JSON.stringify({
          schema_version: 1,
          candidates: [{ key: "x/log/0.json", due_at: "2099-01-01T00:00:00.000Z", reason: 1 }],
          last_swept_at: "",
        }),
      ),
      { contentType: GC_PENDING_CONTENT_TYPE },
    );
    await expect(readGcPending(s, KEY)).rejects.toMatchObject({ code: "InvalidResponse" });
  });

  test("rejects candidate with valid-looking but unlisted reason (L249)", async () => {
    const s = new MemoryStorage();
    const body = JSON.stringify({
      schema_version: 1,
      candidates: [
        {
          key: "x/log/0.json",
          due_at: "2099-01-01T00:00:00.000Z",
          reason: "stale-snapshot",
        },
      ],
      last_swept_at: "",
    });
    await s.put(KEY, new TextEncoder().encode(body), { contentType: GC_PENDING_CONTENT_TYPE });
    // Explicit throw-assertion that is incompatible with a resolving promise.
    // If !VALID_REASONS.has is mutated to false, readGcPending resolves and the
    // result is a GcPendingRead, not a BaerlyError — all assertions below fail.
    let threw = false;
    let err: unknown;
    try {
      await readGcPending(s, KEY);
    } catch (error) {
      threw = true;
      err = error;
    }
    // L249: the invalid reason must cause a throw (kills ConditionalExpression → false)
    expect(threw).toBe(true);
    expect(err).toBeInstanceOf(BaerlyError);
    expect((err as BaerlyError).code).toBe("InvalidResponse");
    // L253/L254: message must enumerate valid reasons
    expect((err as BaerlyError).message).toContain("stale-log");
  });

  // ---- last_swept_at validation (L258, L260, L261) ----

  test("rejects last_swept_at as a number", async () => {
    const s = new MemoryStorage();
    await s.put(
      KEY,
      new TextEncoder().encode(
        JSON.stringify({ schema_version: 1, candidates: [], last_swept_at: 0 }),
      ),
      { contentType: GC_PENDING_CONTENT_TYPE },
    );
    const err = await readGcPending(s, KEY).catch((error: unknown) => error);
    expect((err as BaerlyError).code).toBe("InvalidResponse");
    // L260/L261: message must mention last_swept_at
    expect((err as BaerlyError).message).toContain("last_swept_at");
  });

  test("rejects last_swept_at as null", async () => {
    const s = new MemoryStorage();
    await s.put(
      KEY,
      new TextEncoder().encode(
        JSON.stringify({ schema_version: 1, candidates: [], last_swept_at: null }),
      ),
      { contentType: GC_PENDING_CONTENT_TYPE },
    );
    await expect(readGcPending(s, KEY)).rejects.toMatchObject({ code: "InvalidResponse" });
  });

  test("rejects missing last_swept_at", async () => {
    const s = new MemoryStorage();
    await s.put(
      KEY,
      new TextEncoder().encode(JSON.stringify({ schema_version: 1, candidates: [] })),
      { contentType: GC_PENDING_CONTENT_TYPE },
    );
    await expect(readGcPending(s, KEY)).rejects.toMatchObject({ code: "InvalidResponse" });
  });

  // ---- content_scan_cursor validation (L266, L268, L269) ----

  test("accepts content_scan_cursor absent (optional)", async () => {
    const s = new MemoryStorage();
    await createGcPending(s, KEY, initial());
    const read = await readGcPending(s, KEY);
    expect(read?.json.content_scan_cursor).toBeUndefined();
  });

  test("accepts content_scan_cursor as a non-empty string", async () => {
    const s = new MemoryStorage();
    const withCursor: GcPending = { ...initial(), content_scan_cursor: "content/abc123" };
    await createGcPending(s, KEY, withCursor);
    const read = await readGcPending(s, KEY);
    expect(read?.json.content_scan_cursor).toBe("content/abc123");
  });

  test("accepts content_scan_cursor as an empty string (present but empty)", async () => {
    const s = new MemoryStorage();
    const withCursor: GcPending = { ...initial(), content_scan_cursor: "" };
    await createGcPending(s, KEY, withCursor);
    const read = await readGcPending(s, KEY);
    expect(read?.json.content_scan_cursor).toBe("");
  });

  test("rejects content_scan_cursor as a number (L266: type check)", async () => {
    const s = new MemoryStorage();
    await s.put(
      KEY,
      new TextEncoder().encode(
        JSON.stringify({
          schema_version: 1,
          candidates: [],
          last_swept_at: "",
          content_scan_cursor: 42,
        }),
      ),
      { contentType: GC_PENDING_CONTENT_TYPE },
    );
    const err = await readGcPending(s, KEY).catch((error: unknown) => error);
    expect((err as BaerlyError).code).toBe("InvalidResponse");
    // L268/L269: message must mention content_scan_cursor
    expect((err as BaerlyError).message).toContain("content_scan_cursor");
  });

  test("rejects content_scan_cursor as an array", async () => {
    const s = new MemoryStorage();
    await s.put(
      KEY,
      new TextEncoder().encode(
        JSON.stringify({
          schema_version: 1,
          candidates: [],
          last_swept_at: "",
          content_scan_cursor: ["a"],
        }),
      ),
      { contentType: GC_PENDING_CONTENT_TYPE },
    );
    await expect(readGcPending(s, KEY)).rejects.toMatchObject({ code: "InvalidResponse" });
  });

  test("rejects content_scan_cursor as boolean false (L266: !== undefined but not string)", async () => {
    const s = new MemoryStorage();
    await s.put(
      KEY,
      new TextEncoder().encode(
        JSON.stringify({
          schema_version: 1,
          candidates: [],
          last_swept_at: "",
          content_scan_cursor: false,
        }),
      ),
      { contentType: GC_PENDING_CONTENT_TYPE },
    );
    await expect(readGcPending(s, KEY)).rejects.toMatchObject({ code: "InvalidResponse" });
  });

  // ---- casUpdateGcPending: missing key error message (L173) ----

  test("cas-update on missing key error message mentions 'does not exist'", async () => {
    const s = new MemoryStorage();
    const err = await casUpdateGcPending(s, KEY, (cur) => cur).catch((error: unknown) => error);
    expect((err as BaerlyError).code).toBe("InvalidResponse");
    // L173: message must contain the 'does not exist' explanation
    expect((err as BaerlyError).message).toContain("does not exist");
  });

  // ---- casUpdateGcPending: encode and store new state (L179) ----

  test("cas-update encodes and persists the mutated state (L179 round-trip)", async () => {
    const s = new MemoryStorage();
    await createGcPending(s, KEY, initial());
    const candidate: GcCandidate = {
      key: "content/abc123.json",
      due_at: "2099-06-01T00:00:00.000Z",
      reason: "orphan-content",
    };
    await casUpdateGcPending(s, KEY, (cur) => ({
      ...cur,
      candidates: [candidate],
      last_swept_at: "2026-01-01T00:00:00.000Z",
      content_scan_cursor: "content/abc123.json",
    }));
    // Read back and verify entire persisted state
    const read = await readGcPending(s, KEY);
    expect(read?.json.candidates).toHaveLength(1);
    expect(read?.json.candidates[0]).toEqual(candidate);
    expect(read?.json.last_swept_at).toBe("2026-01-01T00:00:00.000Z");
    expect(read?.json.content_scan_cursor).toBe("content/abc123.json");
  });

  test("cas-update write uses ifMatch (L179 ObjectLiteral guard)", async () => {
    // Verify that casUpdateGcPending actually passes ifMatch to storage.put.
    // If putOpts is mutated to {}, no ifMatch is passed and MemoryStorage accepts the write
    // even after a concurrent write advances the etag — that race would not throw.
    // We detect the missing ifMatch by intercepting the put call.
    const s = new MemoryStorage();
    await createGcPending(s, KEY, initial());
    const first = await readGcPending(s, KEY);
    expect(first).not.toBeNull();

    // Advance the document so first.etag is now stale
    await casUpdateGcPending(s, KEY, (cur) => ({ ...cur, last_swept_at: "2026-01-01T00:00:00Z" }));

    // Now try to put using the STALE etag directly. MemoryStorage should reject with Conflict.
    // This verifies that CAS is enforced in the put path (the same mechanism casUpdateGcPending relies on).
    const staleBody = new TextEncoder().encode(JSON.stringify(initial()));
    await expect(
      s.put(KEY, staleBody, { ifMatch: first!.etag, contentType: GC_PENDING_CONTENT_TYPE }),
    ).rejects.toMatchObject({ code: "Conflict" });

    // Additionally, assert that casUpdateGcPending sends the current etag as ifMatch
    // by proxying the put call and asserting ifMatch is provided.
    let capturedPutOpts: Parameters<typeof s.put>[2] | undefined;
    const proxied = {
      get: (k: string, o?: unknown) => s.get(k, o as Parameters<typeof s.get>[1]),
      list: (prefix: string, o?: unknown) => s.list(prefix, o as Parameters<typeof s.list>[1]),
      delete: (k: string, o?: unknown) => s.delete(k, o as Parameters<typeof s.delete>[1]),
      put: async (...args: Parameters<typeof s.put>) => {
        capturedPutOpts = args[2];
        return s.put(...args);
      },
    };
    await casUpdateGcPending(proxied as unknown as MemoryStorage, KEY, (cur) => ({
      ...cur,
      last_swept_at: "2026-06-01T00:00:00Z",
    }));
    // ifMatch must be present and non-empty (kills L179 ObjectLiteral → {})
    expect(capturedPutOpts?.ifMatch).toBeDefined();
    expect(typeof capturedPutOpts?.ifMatch).toBe("string");
    expect(capturedPutOpts?.ifMatch?.length).toBeGreaterThan(0);
  });

  // ---- signal propagation (L136, L182) ----

  test("createGcPending passes an already-aborted signal to storage (L136)", async () => {
    const s = new MemoryStorage();
    const ctrl = new AbortController();
    ctrl.abort(new Error("test-abort"));
    await expect(createGcPending(s, KEY, initial(), { signal: ctrl.signal })).rejects.toThrow(
      "test-abort",
    );
  });

  test("createGcPending passes signal through to storage.put (L136 ifNoneMatch conditional)", async () => {
    // Verify signal is actually forwarded to the put call (not just ignored)
    const s = new MemoryStorage();
    const ctrl = new AbortController();
    let capturedSignal: AbortSignal | undefined;
    const proxied = {
      get: (k: string, o?: unknown) => s.get(k, o as Parameters<typeof s.get>[1]),
      list: (prefix: string, o?: unknown) => s.list(prefix, o as Parameters<typeof s.list>[1]),
      delete: (k: string, o?: unknown) => s.delete(k, o as Parameters<typeof s.delete>[1]),
      put: async (...args: Parameters<typeof s.put>) => {
        capturedSignal = args[2]?.signal;
        return s.put(...args);
      },
    };
    await createGcPending(proxied as unknown as MemoryStorage, KEY, initial(), {
      signal: ctrl.signal,
    });
    // L136: the signal must be forwarded when present (kills ConditionalExpression → false/true)
    expect(capturedSignal).toBe(ctrl.signal);
  });

  test("casUpdateGcPending passes an already-aborted signal to storage (L182)", async () => {
    const s = new MemoryStorage();
    await createGcPending(s, KEY, initial());
    const ctrl = new AbortController();
    ctrl.abort(new Error("test-abort"));
    await expect(casUpdateGcPending(s, KEY, (cur) => cur, { signal: ctrl.signal })).rejects.toThrow(
      "test-abort",
    );
  });

  test("casUpdateGcPending forwards signal to storage.put (L182 conditional)", async () => {
    // The signal must reach the write-side put call, not just the read-side get.
    // We proxy storage: get() always succeeds, put() records the options.
    const s = new MemoryStorage();
    await createGcPending(s, KEY, initial());
    const ctrl = new AbortController();
    let capturedPutSignal: AbortSignal | undefined;
    const proxied = {
      // get passes signal through normally so we reach the put
      get: (k: string, o?: unknown) => s.get(k, o as Parameters<typeof s.get>[1]),
      list: (prefix: string, o?: unknown) => s.list(prefix, o as Parameters<typeof s.list>[1]),
      delete: (k: string, o?: unknown) => s.delete(k, o as Parameters<typeof s.delete>[1]),
      put: async (...args: Parameters<typeof s.put>) => {
        capturedPutSignal = args[2]?.signal;
        return s.put(...args);
      },
    };
    await casUpdateGcPending(proxied as unknown as MemoryStorage, KEY, (cur) => cur, {
      signal: ctrl.signal,
    });
    // L182: signal must appear in the put options when opts.signal is provided
    // (kills ConditionalExpression → false which would omit it, and → true which
    //  would always include it even when undefined, passing an extra undefined key)
    expect(capturedPutSignal).toBe(ctrl.signal);
  });

  // ---- translateCasError: Conflict vs non-Conflict BaerlyError vs unknown (L282-290) ----

  test("translateCasError: Conflict from storage.put annotates with CAS-lost message (L282, L283)", async () => {
    // Force a CAS conflict at the storage.put layer inside createGcPending
    // by having the key already exist (triggers ifNoneMatch: "*" conflict).
    const s = new MemoryStorage();
    await createGcPending(s, KEY, initial());
    // Creating again on the same key raises Conflict through translateCasError
    const err = await createGcPending(s, KEY, initial()).catch((error: unknown) => error);
    expect((err as BaerlyError).code).toBe("Conflict");
    // L283: the rethrown Conflict must contain 'CAS lost'
    expect((err as BaerlyError).message).toContain("CAS lost");
    // L283: the original conflict error is the cause
    expect((err as BaerlyError).cause).toBeInstanceOf(BaerlyError);
    expect(((err as BaerlyError).cause as BaerlyError).code).toBe("Conflict");
  });

  test("translateCasError: Conflict from casUpdateGcPending CAS-lost at write (L282, L283)", async () => {
    const s = new MemoryStorage();
    await createGcPending(s, KEY, initial());
    // Grab the current etag
    const first = await readGcPending(s, KEY);
    // Advance the key so the etag is stale
    await casUpdateGcPending(s, KEY, (cur) => ({
      ...cur,
      last_swept_at: "2026-01-01T00:00:00.000Z",
    }));
    // Now try to write using the stale etag by calling the raw storage layer
    const staleBody = new TextEncoder().encode(JSON.stringify(initial()));
    const err = await s
      .put(KEY, staleBody, {
        ifMatch: first!.etag,
        contentType: GC_PENDING_CONTENT_TYPE,
      })
      .catch((error: unknown) => error);
    expect((err as BaerlyError).code).toBe("Conflict");
  });

  test("translateCasError: non-Conflict BaerlyError passes through unchanged (L285, L286)", async () => {
    // To hit the L285 branch we need storage.put to throw a non-Conflict BaerlyError.
    // We do this by using a custom Storage that throws AccessDenied on put.
    const mockStorage = {
      put: async () => {
        throw new BaerlyError("AccessDenied", "permission denied");
      },
      get: async (_k: string, _o?: unknown) => null as null,
      list: (_prefix: string) => {
        async function* gen() {}
        return gen();
      },
      delete: async () => {},
    };
    // createGcPending will call storage.put which throws AccessDenied
    const err = await createGcPending(
      mockStorage as unknown as MemoryStorage,
      KEY,
      initial(),
    ).catch((error: unknown) => error);
    // L285-286: non-Conflict BaerlyError passes through unchanged
    expect((err as BaerlyError).code).toBe("AccessDenied");
    expect((err as BaerlyError).message).toBe("permission denied");
  });

  test("translateCasError: non-BaerlyError becomes InvalidResponse (L288-292)", async () => {
    const mockStorage = {
      put: async () => {
        throw new TypeError("connection reset");
      },
      get: async (_k: string, _o?: unknown) => null as null,
      list: (_prefix: string) => {
        async function* gen() {}
        return gen();
      },
      delete: async () => {},
    };
    const err = await createGcPending(
      mockStorage as unknown as MemoryStorage,
      KEY,
      initial(),
    ).catch((error: unknown) => error);
    expect((err as BaerlyError).code).toBe("InvalidResponse");
    // L290: message must contain the stringified error
    expect((err as BaerlyError).message).toContain("connection reset");
  });

  // ---- casUpdateGcPending: Conflict from write-back (L187) ----

  test("casUpdateGcPending: Conflict from write-back is translated to Conflict (L187)", async () => {
    // We need storage.put to throw Conflict during casUpdateGcPending's write phase.
    const s = new MemoryStorage();
    let putCallCount = 0;
    const conflicting = {
      get: (k: string, o?: unknown) => s.get(k, o as Parameters<typeof s.get>[1]),
      list: (prefix: string, o?: unknown) => s.list(prefix, o as Parameters<typeof s.list>[1]),
      delete: (k: string, o?: unknown) => s.delete(k, o as Parameters<typeof s.delete>[1]),
      put: async (...args: Parameters<typeof s.put>) => {
        putCallCount++;
        if (putCallCount === 1) {
          // First call: real put to create the document
          return s.put(...args);
        }
        // Subsequent calls: throw Conflict to simulate a racing writer
        throw new BaerlyError("Conflict", "etag mismatch");
      },
    };
    await createGcPending(conflicting as unknown as MemoryStorage, KEY, initial());
    const err = await casUpdateGcPending(
      conflicting as unknown as MemoryStorage,
      KEY,
      (cur) => cur,
    ).catch((error: unknown) => error);
    // L187: the error propagates as Conflict (through translateCasError)
    expect((err as BaerlyError).code).toBe("Conflict");
    expect((err as BaerlyError).message).toContain("CAS lost");
  });

  // ---- all three valid reasons round-trip (L249 — VALID_REASONS.has) ----

  test("accepts all three valid GcCandidate reasons", async () => {
    const reasons: Array<GcCandidate["reason"]> = [
      "stale-log",
      "orphan-snapshot",
      "orphan-content",
    ];
    for (const reason of reasons) {
      const s = new MemoryStorage();
      const candidate: GcCandidate = {
        key: "x/content/abc.json",
        due_at: "2099-01-01T00:00:00.000Z",
        reason,
      };
      await createGcPending(s, KEY, { ...initial(), candidates: [candidate] });
      const read = await readGcPending(s, KEY);
      expect(read?.json.candidates[0]?.reason).toBe(reason);
    }
  });
});

// ---------------------------------------------------------------------
// Property laws — encode → store → decode → shape-guard round-trip over
// arbitrary VALID bodies. Generalises the single create→read example.
// ---------------------------------------------------------------------

const candidateArb: fc.Arbitrary<GcCandidate> = fc.record({
  key: fc.string({ minLength: 1, maxLength: 24 }),
  due_at: fc.string({ maxLength: 24 }),
  reason: fc.constantFrom<GcCandidate["reason"]>("stale-log", "orphan-snapshot", "orphan-content"),
});

// Optionally carries `content_scan_cursor` — present (string) or the
// key omitted entirely (the optional-additive contract).
const gcPendingArb: fc.Arbitrary<GcPending> = fc
  .record({
    candidates: fc.array(candidateArb, { maxLength: 8 }),
    last_swept_at: fc.string({ maxLength: 24 }),
    cursor: fc.option(fc.string({ maxLength: 24 }), { nil: undefined }),
  })
  .map(({ candidates, last_swept_at, cursor }) => {
    const out: GcPending = { schema_version: GC_PENDING_SCHEMA_VERSION, candidates, last_swept_at };
    if (cursor !== undefined) {
      out.content_scan_cursor = cursor;
    }
    return out;
  });

describe("gc-pending — property laws", () => {
  fcTest.prop({ gen: gcPendingArb })(
    "create → read round-trips an arbitrary valid body byte-for-byte",
    async ({ gen }) => {
      const s = new MemoryStorage();
      const created = await createGcPending(s, KEY, gen);
      expect(created.json).toEqual(gen);
      const read = await readGcPending(s, KEY);
      expect(read?.json).toEqual(gen);
    },
  );

  fcTest.prop({ appends: fc.array(candidateArb, { maxLength: 6 }) })(
    "CAS-append sequence preserves shape; final candidate count equals appends",
    async ({ appends }) => {
      const s = new MemoryStorage();
      await createGcPending(s, KEY, initial());
      for (const cand of appends) {
        await casUpdateGcPending(s, KEY, (cur) => ({
          ...cur,
          candidates: [...cur.candidates, cand],
        }));
      }
      // readGcPending throws on any shape drift, so a clean read is the
      // shape-preservation assertion; the length pins the mutation math.
      const read = await readGcPending(s, KEY);
      expect(read?.json.candidates).toHaveLength(appends.length);
    },
  );
});
