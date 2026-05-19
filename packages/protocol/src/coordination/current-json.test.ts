import { fc, test } from "@fast-check/vitest";
import { describe, expect, test as plainTest } from "vitest";
import {
  CURRENT_JSON_SCHEMA_VERSION,
  type CurrentJson,
  casUpdateCurrentJson,
  claimWriter,
  createCurrentJson,
  logSeqStartOf,
  MemoryStorage,
  readCurrentJson,
} from "../index.ts";
import type { Storage, StoragePutOptions, StoragePutResult } from "../storage/types.ts";

const seedJson = (overrides: Partial<CurrentJson> = {}): CurrentJson => ({
  schema_version: CURRENT_JSON_SCHEMA_VERSION,
  snapshot: null,
  next_seq: 0,
  log_seq_start: 0,
  writer_fence: { epoch: 0, owner: "test", claimed_at: "" },
  ...overrides,
});

describe("readCurrentJson", () => {
  plainTest("returns null on missing key", async () => {
    const s = new MemoryStorage();
    await expect(readCurrentJson(s, "tenant/coll/current.json")).resolves.toBeNull();
  });

  plainTest("round-trips a valid record", async () => {
    const s = new MemoryStorage();
    const seeded = seedJson();
    await createCurrentJson(s, "k", seeded);
    const got = await readCurrentJson(s, "k");
    expect(got).not.toBeNull();
    expect(got!.json).toEqual(seeded);
    expect(typeof got!.etag).toBe("string");
  });

  plainTest("rejects malformed JSON with InvalidResponse", async () => {
    const s = new MemoryStorage();
    await s.put("k", new TextEncoder().encode("{not json"));
    await expect(readCurrentJson(s, "k")).rejects.toMatchObject({
      code: "InvalidResponse",
    });
  });

  plainTest("rejects unknown schema_version", async () => {
    const s = new MemoryStorage();
    await s.put(
      "k",
      new TextEncoder().encode(JSON.stringify({ ...seedJson(), schema_version: 99 })),
    );
    await expect(readCurrentJson(s, "k")).rejects.toMatchObject({
      code: "InvalidResponse",
    });
  });

  plainTest("rejects record missing writer_fence", async () => {
    const s = new MemoryStorage();
    const { writer_fence: _omit, ...without } = seedJson();
    await s.put("k", new TextEncoder().encode(JSON.stringify(without)));
    await expect(readCurrentJson(s, "k")).rejects.toMatchObject({
      code: "InvalidResponse",
    });
  });
});

describe("createCurrentJson", () => {
  plainTest("succeeds on missing key, returns etag", async () => {
    const s = new MemoryStorage();
    const r = await createCurrentJson(s, "k", seedJson());
    expect(r.etag).toMatch(/^"[0-9a-f]+"$/);
  });

  plainTest("throws Conflict on existing key", async () => {
    const s = new MemoryStorage();
    await createCurrentJson(s, "k", seedJson());
    await expect(createCurrentJson(s, "k", seedJson({ next_seq: 1 }))).rejects.toMatchObject({
      code: "Conflict",
    });
  });
});

describe("casUpdateCurrentJson", () => {
  plainTest("mutator runs on a clone — caller-visible storage unchanged", async () => {
    const s = new MemoryStorage();
    await createCurrentJson(s, "k", seedJson());
    let observed: CurrentJson | undefined;
    await casUpdateCurrentJson(s, "k", (current) => {
      observed = current;
      return { ...current, next_seq: current.next_seq + 1 };
    });
    // structuredClone means after-the-fact mutation of `observed` cannot
    // affect what landed in storage.
    observed!.next_seq = 999;
    const got = await readCurrentJson(s, "k");
    expect(got!.json.next_seq).toBe(1);
  });

  plainTest("throws Conflict deterministically when interleaved", async () => {
    const s = new MemoryStorage();
    await createCurrentJson(s, "k", seedJson());
    // Both reads complete before either put fires (Promise.allSettled
    // serializes neither). Both writes commit at the same etag; the
    // storage layer surfaces the second one as `Conflict`.
    let mutator1Calls = 0;
    let mutator2Calls = 0;
    const p1 = casUpdateCurrentJson(s, "k", (c) => {
      mutator1Calls += 1;
      return { ...c, next_seq: c.next_seq + 10 };
    });
    const p2 = casUpdateCurrentJson(s, "k", (c) => {
      mutator2Calls += 1;
      return { ...c, next_seq: c.next_seq + 20 };
    });
    const results = await Promise.allSettled([p1, p2]);
    const failed = results.filter((r) => r.status === "rejected");
    expect(failed.length).toBe(1);
    expect((failed[0] as PromiseRejectedResult).reason).toMatchObject({
      code: "Conflict",
    });
    expect(mutator1Calls).toBeGreaterThan(0);
    expect(mutator2Calls).toBeGreaterThan(0);
  });

  plainTest("throws InvalidResponse if key does not exist", async () => {
    const s = new MemoryStorage();
    await expect(casUpdateCurrentJson(s, "missing", (c) => c)).rejects.toMatchObject({
      code: "InvalidResponse",
    });
  });
});

describe("claimWriter", () => {
  plainTest("bumps epoch monotonically across successive claims", async () => {
    const s = new MemoryStorage();
    await createCurrentJson(s, "k", seedJson());
    const after1 = await claimWriter(s, "k", "worker-a");
    expect(after1.json.writer_fence.epoch).toBe(1);
    expect(after1.json.writer_fence.owner).toBe("worker-a");
    const after2 = await claimWriter(s, "k", "worker-b");
    expect(after2.json.writer_fence.epoch).toBe(2);
    expect(after2.json.writer_fence.owner).toBe("worker-b");
  });

  plainTest("stamps claimed_at from Storage.put serverDate (not local clock)", async () => {
    // MemoryStorage.put returns serverDate: new Date(). The function
    // must use *that* value, not Date.now() inside its own code. We
    // can't peek the local-vs-server distinction directly, but we can
    // pin that the result is a parseable ISO string.
    const s = new MemoryStorage();
    await createCurrentJson(s, "k", seedJson());
    const r = await claimWriter(s, "k", "owner");
    expect(r.json.writer_fence.claimed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(new Date(r.json.writer_fence.claimed_at).toString()).not.toBe("Invalid Date");
  });

  plainTest("leaves claimed_at empty when impl returns undefined serverDate", async () => {
    // Wrap MemoryStorage and strip serverDate off the put result, to
    // exercise the "impl doesn't surface a server clock" branch of
    // claimWriter (two-round-trip protocol skips the stamp write).
    const inner = new MemoryStorage();
    const stripped: Storage = {
      get: (k, o) => inner.get(k, o),
      delete: (k, o) => inner.delete(k, o),
      list: (p, o) => inner.list(p, o),
      put: async (k: string, b: Uint8Array, o?: StoragePutOptions): Promise<StoragePutResult> => {
        const r = await inner.put(k, b, o);
        return { etag: r.etag };
      },
    };
    await createCurrentJson(stripped, "k", seedJson());
    const r = await claimWriter(stripped, "k", "owner");
    expect(r.json.writer_fence.claimed_at).toBe("");
    expect(r.json.writer_fence.epoch).toBe(1);
  });
});

describe("CurrentJson schema (PBT)", () => {
  // Enforces the invariant `0 <= log_seq_start <= next_seq` at draw
  // time by chaining a dependent integer arbitrary off `next_seq` so
  // the runtime guard always accepts the produced record.
  const validCurrentJson = fc.integer({ min: 0, max: 1_000_000 }).chain((next_seq) =>
    fc.record({
      schema_version: fc.constant(CURRENT_JSON_SCHEMA_VERSION),
      snapshot: fc.oneof(fc.constant(null), fc.string()),
      next_seq: fc.constant(next_seq),
      log_seq_start: fc.integer({ min: 0, max: next_seq }),
      writer_fence: fc.record({
        epoch: fc.integer({ min: 0, max: 1_000_000 }),
        owner: fc.string(),
        claimed_at: fc.string(),
      }),
    }),
  );

  test.prop({
    initial: validCurrentJson,
    bumps: fc.array(fc.string(), { maxLength: 8 }),
  })("claim sequence: each claim strictly bumps epoch by exactly 1", async ({ initial, bumps }) => {
    const s = new MemoryStorage();
    await createCurrentJson(s, "k", initial);
    let last = initial.writer_fence.epoch;
    for (const owner of bumps) {
      const r = await claimWriter(s, "k", owner);
      expect(r.json.writer_fence.epoch).toBe(last + 1);
      last = r.json.writer_fence.epoch;
    }
  });

  test.prop({ initial: validCurrentJson })(
    "round-trip: createCurrentJson + readCurrentJson preserves shape",
    async ({ initial }) => {
      const s = new MemoryStorage();
      await createCurrentJson(s, "k", initial);
      const got = await readCurrentJson(s, "k");
      expect(got!.json).toEqual(initial);
    },
  );
});

describe("CurrentJson log_seq_start", () => {
  plainTest("logSeqStartOf() returns the seeded 0", () => {
    const c: CurrentJson = seedJson();
    expect(logSeqStartOf(c)).toBe(0);
  });

  plainTest("returns the explicit log_seq_start when present", () => {
    const c: CurrentJson = seedJson({ next_seq: 5, log_seq_start: 3 });
    expect(logSeqStartOf(c)).toBe(3);
  });

  plainTest("preserves the field across a CAS-advance via object spread", async () => {
    const s = new MemoryStorage();
    await createCurrentJson(s, "k", seedJson({ next_seq: 5, log_seq_start: 2 }));
    const updated = await casUpdateCurrentJson(s, "k", (c) => ({ ...c, next_seq: c.next_seq + 1 }));
    expect(updated.json.log_seq_start).toBe(2);
    expect(updated.json.next_seq).toBe(6);
    // And the field round-trips through a fresh read too.
    const reread = await readCurrentJson(s, "k");
    expect(reread!.json.log_seq_start).toBe(2);
  });

  plainTest("rejects records with the field absent (always-present invariant)", async () => {
    // Manually write a record without log_seq_start, then re-read.
    // The runtime guard now requires the field; readers refuse the
    // record rather than defaulting to 0.
    const s = new MemoryStorage();
    const body = JSON.stringify({
      schema_version: CURRENT_JSON_SCHEMA_VERSION,
      snapshot: null,
      next_seq: 0,
      writer_fence: { epoch: 0, owner: "", claimed_at: "" },
    });
    await s.put("k", new TextEncoder().encode(body));
    await expect(readCurrentJson(s, "k")).rejects.toMatchObject({
      code: "InvalidResponse",
      message: expect.stringMatching(/log_seq_start/),
    });
  });

  plainTest("accepts an explicit log_seq_start equal to next_seq (fully compacted)", async () => {
    const s = new MemoryStorage();
    await createCurrentJson(s, "k", seedJson({ next_seq: 7, log_seq_start: 7 }));
    const got = await readCurrentJson(s, "k");
    expect(got!.json.log_seq_start).toBe(7);
    expect(got!.json.next_seq).toBe(7);
  });

  plainTest("rejects negative log_seq_start with InvalidResponse", async () => {
    const s = new MemoryStorage();
    const body = JSON.stringify({
      schema_version: CURRENT_JSON_SCHEMA_VERSION,
      snapshot: null,
      next_seq: 0,
      writer_fence: { epoch: 0, owner: "", claimed_at: "" },
      log_seq_start: -1,
    });
    await s.put("k", new TextEncoder().encode(body));
    await expect(readCurrentJson(s, "k")).rejects.toMatchObject({
      code: "InvalidResponse",
      message: expect.stringMatching(/log_seq_start/),
    });
  });

  plainTest("rejects non-integer log_seq_start with InvalidResponse", async () => {
    const s = new MemoryStorage();
    const body = JSON.stringify({
      schema_version: CURRENT_JSON_SCHEMA_VERSION,
      snapshot: null,
      next_seq: 5,
      writer_fence: { epoch: 0, owner: "", claimed_at: "" },
      log_seq_start: 1.5,
    });
    await s.put("k", new TextEncoder().encode(body));
    await expect(readCurrentJson(s, "k")).rejects.toMatchObject({
      code: "InvalidResponse",
      message: expect.stringMatching(/log_seq_start/),
    });
  });

  plainTest("rejects log_seq_start > next_seq with InvalidResponse", async () => {
    const s = new MemoryStorage();
    const body = JSON.stringify({
      schema_version: CURRENT_JSON_SCHEMA_VERSION,
      snapshot: null,
      next_seq: 1,
      writer_fence: { epoch: 0, owner: "", claimed_at: "" },
      log_seq_start: 2,
    });
    await s.put("k", new TextEncoder().encode(body));
    await expect(readCurrentJson(s, "k")).rejects.toMatchObject({
      code: "InvalidResponse",
      message: expect.stringMatching(/log_seq_start.*next_seq/),
    });
  });
});
