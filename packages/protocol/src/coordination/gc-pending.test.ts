/**
 * `gc/pending.json` control-object helpers. Mirrors
 * `current-json.test.ts` — round-trip, CAS, shape guards.
 */

import { fc, test as fcTest } from "@fast-check/vitest";
import { describe, expect, test } from "vitest";
import { MemoryStorage } from "../storage/memory.ts";
import { BaerlyError } from "../errors.ts";
import { GC_PENDING_SCHEMA_VERSION } from "../constants.ts";
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
