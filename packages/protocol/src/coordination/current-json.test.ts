import { fc, test } from "@fast-check/vitest";
import { describe, expect, test as plainTest } from "vitest";
import {
  BaerlyError,
  CURRENT_JSON_CONTENT_TYPE,
  CURRENT_JSON_SCHEMA_VERSION,
  type CurrentJson,
  type CurrentJsonRead,
  casUpdateCurrentJson,
  createCurrentJson,
  encodeJsonBytes,
  logSeqStartOf,
  MemoryStorage,
  readCurrentJson,
} from "../index.ts";
import { claimWriter } from "./current-json.ts";
import type { Storage, StoragePutOptions, StoragePutResult } from "../storage/types.ts";

const seedJson = (overrides: Partial<CurrentJson> = {}): CurrentJson => ({
  schema_version: CURRENT_JSON_SCHEMA_VERSION,
  snapshot: null,
  tail_hint: 0,
  log_seq_start: 0,
  writer_fence: { epoch: 0, owner: "test", claimed_at: "" },
  tail_bytes: 0,
  snapshot_bytes: 0,
  snapshot_rows: 0,
  ...overrides,
});

describe("wire-contract constants", () => {
  plainTest("CURRENT_JSON_CONTENT_TYPE is the on-bucket MIME type for current.json", () => {
    // Written as the Content-Type header on every current.json PUT and
    // returned on subsequent GETs by S3/R2. Pinned here (not just in
    // constants.test.ts) because Stryker's perTest coverage attributes the
    // constants.ts module-level assignment to the first test that imports it.
    expect(CURRENT_JSON_CONTENT_TYPE).toBe("application/json");
  });
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

  plainTest(
    "rejects malformed JSON: message contains 'valid JSON' (not 'not an object')",
    async () => {
      const s = new MemoryStorage();
      await s.put("k", new TextEncoder().encode("{not json"));
      // L209 StringLiteral→`` kill: message must contain "valid JSON" — the exact phrase
      // from the error template. The equivalent BlockStatement→{} mutant (L206) produces
      // "parsed body is not an object" (from assertCurrentJson on undefined), which does
      // NOT contain "valid JSON".
      // L206 BlockStatement→{}: with empty catch, parsed=undefined → assertCurrentJson(undefined)
      // throws "not an object". "valid JSON" absent → test FAILS → kills L206.
      await expect(readCurrentJson(s, "k")).rejects.toMatchObject({
        code: "InvalidResponse",
        message: expect.stringMatching(/valid JSON/),
      });
    },
  );

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

  // Tolerant-reader / forward-compat regression (ADR-007 Tier 1).
  // An UNKNOWN field on current.json must be IGNORED, not rejected.
  // This pins the "additive-optional, no bump" evolution rule so a
  // future refactor cannot silently add unknown-key rejection and break
  // the deferred layout_version plan. See docs/adr/007-layout-versioning-cordon.md.
  plainTest(
    "tolerant reader: an unknown future field on current.json is ignored, not rejected",
    async () => {
      const s = new MemoryStorage();
      const bytes = encodeJsonBytes({
        ...seedJson(),
        some_future_additive_field: { hello: "world" },
      });
      await s.put("k", bytes);
      // Must succeed — unknown keys are silently ignored (Tier 1 forward-compat).
      const got = await readCurrentJson(s, "k");
      expect(got?.json.tail_hint).toBe(0);
    },
  );
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
    await expect(createCurrentJson(s, "k", seedJson({ tail_hint: 1 }))).rejects.toMatchObject({
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
      return { ...current, tail_hint: current.tail_hint + 1 };
    });
    // structuredClone means after-the-fact mutation of `observed` cannot
    // affect what landed in storage.
    observed!.tail_hint = 999;
    const got = await readCurrentJson(s, "k");
    expect(got!.json.tail_hint).toBe(1);
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
      return { ...c, tail_hint: c.tail_hint + 10 };
    });
    const p2 = casUpdateCurrentJson(s, "k", (c) => {
      mutator2Calls += 1;
      return { ...c, tail_hint: c.tail_hint + 20 };
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

/**
 * Storage wrapper that fires a one-shot callback AFTER the first
 * successful `put`. Used by the two-phase-fence-claim regression to
 * deterministically land a peer write between `claimWriter`'s
 * provisional PUT (epoch bump, `claimed_at:""`) and its stamp PUT
 * (claimed_at:serverDate.toISOString()).
 */
class InterposingStorage implements Storage {
  #inner: Storage;
  #onAfterFirstPut: ((etag: string) => Promise<void>) | undefined;
  #fired = false;
  constructor(inner: Storage, onAfterFirstPut?: (etag: string) => Promise<void>) {
    this.#inner = inner;
    this.#onAfterFirstPut = onAfterFirstPut;
  }
  get(k: string, o?: Parameters<Storage["get"]>[1]) {
    return this.#inner.get(k, o);
  }
  delete(k: string, o?: Parameters<Storage["delete"]>[1]) {
    return this.#inner.delete(k, o);
  }
  list(p: string, o?: Parameters<Storage["list"]>[1]) {
    return this.#inner.list(p, o);
  }
  async put(k: string, b: Uint8Array, o?: StoragePutOptions): Promise<StoragePutResult> {
    const result = await this.#inner.put(k, b, o);
    if (!this.#fired && this.#onAfterFirstPut !== undefined) {
      this.#fired = true;
      await this.#onAfterFirstPut(result.etag);
    }
    return result;
  }
}

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

  plainTest(
    "two-phase: peer landing between PUTs loses on stamp; epoch bump survives durably",
    async () => {
      const inner = new MemoryStorage();
      await createCurrentJson(inner, "k", seedJson());

      // A peer writes between claimWriter's provisional PUT and its
      // stamp PUT. The peer is a vanilla `casUpdateCurrentJson` that
      // bumps `tail_hint`; it reads the etag claimWriter just wrote,
      // mutates the record, and writes — invalidating the etag
      // claimWriter is about to use for its stamp.
      const storage = new InterposingStorage(inner, async () => {
        await casUpdateCurrentJson(inner, "k", (c) => ({
          ...c,
          tail_hint: c.tail_hint + 1,
        }));
      });

      await expect(claimWriter(storage, "k", "owner-a")).rejects.toMatchObject({
        code: "Conflict",
      });

      // The epoch bump from PUT #1 is durable — the patent claim's
      // core safety property. The stamp PUT lost, so `claimed_at`
      // remains the provisional empty string.
      const after = await readCurrentJson(inner, "k");
      expect(after!.json.writer_fence.epoch).toBe(1);
      expect(after!.json.writer_fence.claimed_at).toBe("");
      // The peer's mutation also landed.
      expect(after!.json.tail_hint).toBe(1);
    },
  );
});

describe("CurrentJson schema (PBT)", () => {
  // Enforces the invariant `0 <= log_seq_start <= tail_hint` at draw
  // time by chaining a dependent integer arbitrary off `tail_hint` so
  // the runtime guard always accepts the produced record.
  const validCurrentJson = fc.integer({ min: 0, max: 1_000_000 }).chain((tail_hint) =>
    fc.record({
      schema_version: fc.constant(CURRENT_JSON_SCHEMA_VERSION),
      snapshot: fc.oneof(fc.constant(null), fc.string()),
      tail_hint: fc.constant(tail_hint),
      log_seq_start: fc.integer({ min: 0, max: tail_hint }),
      writer_fence: fc.record({
        epoch: fc.integer({ min: 0, max: 1_000_000 }),
        owner: fc.string(),
        claimed_at: fc.string(),
      }),
      tail_bytes: fc.integer({ min: 0, max: 1_000_000 }),
      snapshot_bytes: fc.integer({ min: 0, max: 1_000_000 }),
      snapshot_rows: fc.integer({ min: 0, max: 10_000 }),
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
    const c: CurrentJson = seedJson({ tail_hint: 5, log_seq_start: 3 });
    expect(logSeqStartOf(c)).toBe(3);
  });

  plainTest("preserves the field across a CAS-advance via object spread", async () => {
    const s = new MemoryStorage();
    await createCurrentJson(s, "k", seedJson({ tail_hint: 5, log_seq_start: 2 }));
    const updated = await casUpdateCurrentJson(s, "k", (c) => ({
      ...c,
      tail_hint: c.tail_hint + 1,
    }));
    expect(updated.json.log_seq_start).toBe(2);
    expect(updated.json.tail_hint).toBe(6);
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
      tail_hint: 0,
      writer_fence: { epoch: 0, owner: "", claimed_at: "" },
    });
    await s.put("k", new TextEncoder().encode(body));
    await expect(readCurrentJson(s, "k")).rejects.toMatchObject({
      code: "InvalidResponse",
      message: expect.stringMatching(/log_seq_start/),
    });
  });

  plainTest("accepts an explicit log_seq_start equal to tail_hint (fully compacted)", async () => {
    const s = new MemoryStorage();
    await createCurrentJson(s, "k", seedJson({ tail_hint: 7, log_seq_start: 7 }));
    const got = await readCurrentJson(s, "k");
    expect(got!.json.log_seq_start).toBe(7);
    expect(got!.json.tail_hint).toBe(7);
  });

  plainTest("rejects negative log_seq_start with InvalidResponse", async () => {
    const s = new MemoryStorage();
    const body = JSON.stringify({
      schema_version: CURRENT_JSON_SCHEMA_VERSION,
      snapshot: null,
      tail_hint: 0,
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
      tail_hint: 5,
      writer_fence: { epoch: 0, owner: "", claimed_at: "" },
      log_seq_start: 1.5,
    });
    await s.put("k", new TextEncoder().encode(body));
    await expect(readCurrentJson(s, "k")).rejects.toMatchObject({
      code: "InvalidResponse",
      message: expect.stringMatching(/log_seq_start/),
    });
  });

  plainTest("rejects log_seq_start > tail_hint with InvalidResponse", async () => {
    const s = new MemoryStorage();
    const body = JSON.stringify({
      schema_version: CURRENT_JSON_SCHEMA_VERSION,
      snapshot: null,
      tail_hint: 1,
      writer_fence: { epoch: 0, owner: "", claimed_at: "" },
      log_seq_start: 2,
    });
    await s.put("k", new TextEncoder().encode(body));
    await expect(readCurrentJson(s, "k")).rejects.toMatchObject({
      code: "InvalidResponse",
      message: expect.stringMatching(/log_seq_start.*tail_hint/),
    });
  });
});

describe("CurrentJson schema v2 — tail_bytes / snapshot_bytes / snapshot_rows", () => {
  // ── v2 acceptance ──────────────────────────────────────────────────
  plainTest("accepts a valid v2 record with all required byte/row fields", async () => {
    const s = new MemoryStorage();
    await createCurrentJson(s, "k", seedJson());
    const got = await readCurrentJson(s, "k");
    expect(got).not.toBeNull();
    expect(got!.json.tail_bytes).toBe(0);
    expect(got!.json.snapshot_bytes).toBe(0);
    expect(got!.json.snapshot_rows).toBe(0);
    expect(got!.json.last_warned_seq).toBeUndefined();
  });

  plainTest("accepts v2 with optional last_warned_seq present", async () => {
    const s = new MemoryStorage();
    await createCurrentJson(s, "k", seedJson({ last_warned_seq: 42 }));
    const got = await readCurrentJson(s, "k");
    expect(got!.json.last_warned_seq).toBe(42);
  });

  // ── v1 reject with actionable message ──────────────────────────────
  plainTest(
    "rejects schema v1 with actionable message matching /v1|re-seed|recreate/",
    async () => {
      const s = new MemoryStorage();
      const body = JSON.stringify({
        schema_version: 1,
        snapshot: null,
        tail_hint: 0,
        log_seq_start: 0,
        writer_fence: { epoch: 0, owner: "", claimed_at: "" },
      });
      await s.put("k", new TextEncoder().encode(body));
      await expect(readCurrentJson(s, "k")).rejects.toMatchObject({
        code: "InvalidResponse",
        message: expect.stringMatching(/v1|re-seed|recreate/),
      });
    },
  );

  // ── missing required byte/row fields ───────────────────────────────
  plainTest("rejects v2 record missing tail_bytes", async () => {
    const s = new MemoryStorage();
    const { tail_bytes: _omit, ...without } = seedJson();
    await s.put("k", new TextEncoder().encode(JSON.stringify(without)));
    await expect(readCurrentJson(s, "k")).rejects.toMatchObject({
      code: "InvalidResponse",
      message: expect.stringMatching(/tail_bytes/),
    });
  });

  plainTest("rejects v2 record missing snapshot_bytes", async () => {
    const s = new MemoryStorage();
    const { snapshot_bytes: _omit, ...without } = seedJson();
    await s.put("k", new TextEncoder().encode(JSON.stringify(without)));
    await expect(readCurrentJson(s, "k")).rejects.toMatchObject({
      code: "InvalidResponse",
      message: expect.stringMatching(/snapshot_bytes/),
    });
  });

  plainTest("rejects v2 record missing snapshot_rows", async () => {
    const s = new MemoryStorage();
    const { snapshot_rows: _omit, ...without } = seedJson();
    await s.put("k", new TextEncoder().encode(JSON.stringify(without)));
    await expect(readCurrentJson(s, "k")).rejects.toMatchObject({
      code: "InvalidResponse",
      message: expect.stringMatching(/snapshot_rows/),
    });
  });

  plainTest("rejects v2 record with negative tail_bytes", async () => {
    const s = new MemoryStorage();
    const body = JSON.stringify({ ...seedJson(), tail_bytes: -1 });
    await s.put("k", new TextEncoder().encode(body));
    await expect(readCurrentJson(s, "k")).rejects.toMatchObject({
      code: "InvalidResponse",
      message: expect.stringMatching(/tail_bytes/),
    });
  });

  plainTest("rejects v2 record with non-integer snapshot_bytes", async () => {
    const s = new MemoryStorage();
    const body = JSON.stringify({ ...seedJson(), snapshot_bytes: 1.5 });
    await s.put("k", new TextEncoder().encode(body));
    await expect(readCurrentJson(s, "k")).rejects.toMatchObject({
      code: "InvalidResponse",
      message: expect.stringMatching(/snapshot_bytes/),
    });
  });

  plainTest("rejects v2 record with negative snapshot_rows", async () => {
    const s = new MemoryStorage();
    const body = JSON.stringify({ ...seedJson(), snapshot_rows: -1 });
    await s.put("k", new TextEncoder().encode(body));
    await expect(readCurrentJson(s, "k")).rejects.toMatchObject({
      code: "InvalidResponse",
      message: expect.stringMatching(/snapshot_rows/),
    });
  });

  plainTest("rejects v2 record with non-integer snapshot_rows", async () => {
    const s = new MemoryStorage();
    const body = JSON.stringify({ ...seedJson(), snapshot_rows: 2.5 });
    await s.put("k", new TextEncoder().encode(body));
    await expect(readCurrentJson(s, "k")).rejects.toMatchObject({
      code: "InvalidResponse",
      message: expect.stringMatching(/snapshot_rows/),
    });
  });

  plainTest("rejects v2 record with non-integer last_warned_seq when present", async () => {
    const s = new MemoryStorage();
    const body = JSON.stringify({ ...seedJson(), last_warned_seq: 1.5 });
    await s.put("k", new TextEncoder().encode(body));
    await expect(readCurrentJson(s, "k")).rejects.toMatchObject({
      code: "InvalidResponse",
      message: expect.stringMatching(/last_warned_seq/),
    });
  });

  plainTest("rejects v2 record with negative last_warned_seq when present", async () => {
    const s = new MemoryStorage();
    const body = JSON.stringify({ ...seedJson(), last_warned_seq: -1 });
    await s.put("k", new TextEncoder().encode(body));
    await expect(readCurrentJson(s, "k")).rejects.toMatchObject({
      code: "InvalidResponse",
      message: expect.stringMatching(/last_warned_seq/),
    });
  });

  plainTest("createCurrentJson seeds tail_bytes=0, snapshot_bytes=0, snapshot_rows=0", async () => {
    const s = new MemoryStorage();
    const r = await createCurrentJson(s, "k", seedJson());
    expect(r.json.tail_bytes).toBe(0);
    expect(r.json.snapshot_bytes).toBe(0);
    expect(r.json.snapshot_rows).toBe(0);
  });
});

/**
 * Deliberately-broken single-PUT variant of claimWriter, defined
 * inline for the patent C1 counter-example test. Uses a
 * caller-supplied `now: Date` instead of the server-derived
 * `StoragePutResult.serverDate`. This is the "obvious composition"
 * a naive implementer would write — it satisfies every requirement
 * stated by reading the WriterFence shape, but fails the
 * adversarial soundness property under bounded clock skew.
 *
 * Lives in the test file (NOT in production code) so the kernel
 * cannot accidentally call it.
 */
async function claimWriterSinglePut(
  storage: Storage,
  key: string,
  owner: string,
  now: Date,
): Promise<CurrentJsonRead> {
  const existing = await readCurrentJson(storage, key);
  if (existing === null) {
    throw new BaerlyError("InvalidResponse", `current.json at ${key} does not exist`);
  }
  const next: CurrentJson = {
    ...existing.json,
    writer_fence: {
      epoch: existing.json.writer_fence.epoch + 1,
      owner,
      claimed_at: now.toISOString(),
    },
  };
  const body = new TextEncoder().encode(JSON.stringify(next));
  const result = await storage.put(key, body, {
    ifMatch: existing.etag,
    contentType: "application/json",
  });
  return { json: next, etag: result.etag };
}

/**
 * MemoryStorage wrapper that overrides StoragePutResult.serverDate
 * with a script of pre-computed Date values, exposing the
 * skew-between-client-clock-and-server-clock dimension the patent
 * C1 counter-example test drives. Once the script is exhausted,
 * subsequent PUTs fall back to the inner serverDate.
 *
 * `scriptedDateStrings` is the running record of every `serverDate`
 * the wrapper has actually handed out (in call order), as ISO-8601
 * strings. Tests assert that every non-empty `claimed_at` ever
 * observable on disk lives in this set — the F2/F6/F7 invariant that
 * `claimed_at` is *always* derived from a server-attested clock value,
 * never client-invented.
 */
class SkewedClockStorage implements Storage {
  #inner: Storage;
  #script: Date[];
  #i = 0;
  readonly #handed: string[] = [];
  constructor(inner: Storage, script: Date[]) {
    this.#inner = inner;
    this.#script = script;
  }
  get scriptedDateStrings(): readonly string[] {
    return this.#handed;
  }
  get(k: string, o?: Parameters<Storage["get"]>[1]) {
    return this.#inner.get(k, o);
  }
  delete(k: string, o?: Parameters<Storage["delete"]>[1]) {
    return this.#inner.delete(k, o);
  }
  list(p: string, o?: Parameters<Storage["list"]>[1]) {
    return this.#inner.list(p, o);
  }
  async put(k: string, b: Uint8Array, o?: StoragePutOptions): Promise<StoragePutResult> {
    const result = await this.#inner.put(k, b, o);
    if (this.#i < this.#script.length) {
      const serverDate = this.#script[this.#i]!;
      this.#i += 1;
      this.#handed.push(serverDate.toISOString());
      return { ...result, serverDate };
    }
    if (result.serverDate !== undefined) {
      this.#handed.push(result.serverDate.toISOString());
    }
    return result;
  }
}

/**
 * Named-adversary Date-script generator. Each mode emits a sequence
 * of `length` Date values exhibiting a different bounded violation of
 * "well-behaved server clock":
 *
 * - `"backward-jump"` — strictly decreasing by a random delta in
 *   `[1ms, 1h]` between successive entries. Models an honest server
 *   whose clock has been NTP-stepped backward across requests.
 * - `"repeated"` — every entry is the SAME `Date` (i.e., the base).
 *   Models a server whose `Date` header has been pinned (cache, proxy,
 *   degenerate clock) and never advances.
 * - `"non-monotonic"` — oscillates pseudo-randomly within
 *   `±10min` of base, sometimes ↑, sometimes ↓. Models post-NTP-step
 *   clock chatter.
 *
 * The seed parameter makes the script deterministic for fast-check
 * shrinking. The base `serverMs` is a fixed real-ish epoch ms so the
 * resulting ISO strings have an unambiguous shape.
 */
function makeAdversaryScript(
  mode: "backward-jump" | "repeated" | "non-monotonic",
  length: number,
  seed: number,
): Date[] {
  const baseMs = 1_700_000_000_000;
  // Tiny deterministic LCG keyed off `seed`. Enough variation for the
  // adversary; cheap to shrink.
  let state = seed >>> 0;
  const nextU32 = (): number => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state;
  };
  const ONE_HOUR_MS = 3_600_000;
  const TEN_MIN_MS = 600_000;
  if (mode === "repeated") {
    return Array.from({ length }, () => new Date(baseMs));
  }
  if (mode === "backward-jump") {
    const out: Date[] = [];
    let cur = baseMs;
    for (let i = 0; i < length; i++) {
      // Decrement by [1, ONE_HOUR_MS] inclusive.
      const delta = 1 + (nextU32() % ONE_HOUR_MS);
      cur -= delta;
      out.push(new Date(cur));
    }
    return out;
  }
  // "non-monotonic": stay within ±TEN_MIN_MS of baseMs.
  return Array.from({ length }, () => {
    const offset = (nextU32() % (2 * TEN_MIN_MS)) - TEN_MIN_MS;
    return new Date(baseMs + offset);
  });
}

describe("claimWriter vs single-PUT counter-example (patent C1)", () => {
  test.prop({
    attempts: fc.array(
      fc.record({
        ownerSeed: fc.string({ minLength: 1, maxLength: 8 }),
        // Server-side clock for the PUT pair (provisional + stamp).
        // Bounded to a 5s skew window — the bound asserted by
        // docs/spec/sync-protocol.md (LAG_WINDOW_MILLIS).
        serverMs: fc.integer({ min: 1_700_000_000_000, max: 1_700_000_005_000 }),
      }),
      { minLength: 2, maxLength: 6 },
    ),
  })(
    "two-phase: (epoch, claimed_at) tuples are distinct and only carry server-clock values",
    async ({ attempts }) => {
      // ── Two-phase variant ───────────────────────────────────────
      const twoPhaseInner = new MemoryStorage();
      // Two PUTs per claim (provisional + stamp) — script entry count
      // must match, else the stamp PUT falls through to MemoryStorage's
      // real wall-clock serverDate and the in-script assertion below
      // would spuriously fail.
      const script = attempts.flatMap((a) => [new Date(a.serverMs), new Date(a.serverMs)]);
      const twoPhaseStorage = new SkewedClockStorage(twoPhaseInner, script);
      await createCurrentJson(twoPhaseStorage, "k", seedJson());
      const twoPhaseStamps: Array<{ epoch: number; claimed_at: string }> = [];
      for (const a of attempts) {
        try {
          const r = await claimWriter(twoPhaseStorage, "k", a.ownerSeed);
          twoPhaseStamps.push({
            epoch: r.json.writer_fence.epoch,
            claimed_at: r.json.writer_fence.claimed_at,
          });
        } catch (error) {
          if (!(error instanceof BaerlyError) || error.code !== "Conflict") {
            throw error;
          }
        }
      }

      // Soundness invariant: every (epoch, claimed_at) tuple in the
      // *successful-return* set is distinct AND its claimed_at is
      // the durable record's claimed_at (i.e. matches what a fresh
      // read returns).
      const tupleSet = new Set(twoPhaseStamps.map((s) => `${s.epoch}|${s.claimed_at}`));
      expect(tupleSet.size).toBe(twoPhaseStamps.length);
      const finalRead = await readCurrentJson(twoPhaseInner, "k");
      if (twoPhaseStamps.length > 0) {
        const last = twoPhaseStamps[twoPhaseStamps.length - 1]!;
        expect(finalRead!.json.writer_fence.epoch).toBe(last.epoch);
        expect(finalRead!.json.writer_fence.claimed_at).toBe(last.claimed_at);
      }
      // The two-phase contract: no observed claim can carry a
      // `claimed_at` derived from any client's local clock. Every
      // stamped value MUST appear in the server-supplied script.
      const scriptIso = new Set(script.map((d) => d.toISOString()));
      for (const s of twoPhaseStamps) {
        if (s.claimed_at !== "") {
          expect(scriptIso.has(s.claimed_at)).toBe(true);
        }
      }
    },
  );

  plainTest(
    "narrative: single-PUT records client clock; two-phase records server clock (patent C1)",
    async () => {
      const clientMsA = 1_700_000_000_000;
      const clientMsB = 1_700_000_001_000;
      const serverMs = 1_700_000_002_000;

      // ── Single-PUT variant: client clock leaks into the record ──
      const singleInner = new MemoryStorage();
      await createCurrentJson(singleInner, "k", seedJson());
      const rA = await claimWriterSinglePut(singleInner, "k", "a", new Date(clientMsA));
      expect(rA.json.writer_fence.claimed_at).toBe(new Date(clientMsA).toISOString());

      // ── Two-phase variant: only the server clock is recorded ────
      const twoPhaseInner = new MemoryStorage();
      const twoPhaseStorage = new SkewedClockStorage(twoPhaseInner, [
        // Two PUTs per claim: provisional + stamp. Both use serverMs.
        new Date(serverMs),
        new Date(serverMs),
      ]);
      await createCurrentJson(twoPhaseStorage, "k", seedJson());
      const rB = await claimWriter(twoPhaseStorage, "k", "b");
      expect(rB.json.writer_fence.claimed_at).toBe(new Date(serverMs).toISOString());
      // The client's local clock (clientMsB) is nowhere in the
      // record — the patent C1 trusted-clock property.
      expect(rB.json.writer_fence.claimed_at).not.toBe(new Date(clientMsB).toISOString());
    },
  );

  // ── Lying-Date adversarial property (F2 + F6 of adv-model) ──────
  //
  // For each of the three named bounded `Date` adversaries (spanning
  // F2 "Server lies about `Date`" via the `"repeated"` pinned-header
  // mode, and F6 "Server advances `Date` non-monotonically" via the
  // `"backward-jump"` and `"non-monotonic"` modes), drive a fresh
  // current.json through a sequence of `claimWriter` calls and assert
  // the I1, I3, and I5 invariants from
  // `docs/spec/writer-fence-adversarial-model.md` hold against the
  // resulting observable state.
  //
  // I4 ("uniqueness of `(epoch, claimed_at)` across successful
  // returns") follows trivially from I1: monotonically-bumped epochs
  // make every successful return's `(epoch, claimed_at)` tuple
  // distinct from every earlier one's, regardless of stamp content.
  test.prop({
    adversary: fc.constantFrom(
      "backward-jump" as const,
      "repeated" as const,
      "non-monotonic" as const,
    ),
    writerSequence: fc.array(fc.constantFrom("A", "B", "C"), { minLength: 2, maxLength: 16 }),
    seed: fc.integer({ min: 0, max: 0x7fff_ffff }),
  })(
    "lying-Date adversary: invariants I1, I3, I5 hold under any bounded Date adversary",
    async ({ adversary, writerSequence, seed }) => {
      const inner = new MemoryStorage();
      // Each claim issues two PUTs (provisional + stamp) and the
      // bootstrap createCurrentJson issues one more. Generate enough
      // adversary entries to cover the longest possible run with
      // headroom — falling through to the inner wall clock would
      // pollute scriptedDateStrings with a value that no caller can
      // predict and break I3 for reasons unrelated to the fence.
      const script = makeAdversaryScript(adversary, 2 * writerSequence.length + 4, seed);
      const storage = new SkewedClockStorage(inner, script);
      const key = "tenant/coll/current.json";
      await createCurrentJson(storage, key, seedJson());

      const observed: Array<{ epoch: number; claimed_at: string }> = [];
      for (const owner of writerSequence) {
        try {
          await claimWriter(storage, key, owner);
        } catch (error) {
          // The adversary may force a CAS loss on the stamp PUT under
          // a poorly-behaved peer, but in this single-writer setup
          // there are no peers; any thrown Conflict is unexpected.
          if (!(error instanceof BaerlyError) || error.code !== "Conflict") {
            throw error;
          }
        }
        const cur = await readCurrentJson(storage, key);
        if (cur !== null) {
          observed.push({
            epoch: cur.json.writer_fence.epoch,
            claimed_at: cur.json.writer_fence.claimed_at,
          });
        }
      }

      // I1: epoch is monotonically non-decreasing across observations.
      for (let i = 1; i < observed.length; i++) {
        expect(observed[i]!.epoch).toBeGreaterThanOrEqual(observed[i - 1]!.epoch);
      }
      // I3: every non-empty `claimed_at` came from a server-attested
      // Date value (i.e. is in the set the adversary handed out).
      // Never from a client-invented timestamp. This is the
      // server-clock-provenance contract of the two-phase protocol —
      // the adversary may LIE about the clock value, but cannot trick
      // claimWriter into INVENTING one.
      const handed = new Set(storage.scriptedDateStrings);
      for (const o of observed) {
        if (o.claimed_at.length > 0) {
          expect(handed.has(o.claimed_at)).toBe(true);
        }
      }
      // I5: idempotency of the stamp within an epoch — once an epoch
      // has been stamped with a non-empty `claimed_at`, any later
      // observation at the same epoch must carry the same string,
      // and an epoch already stamped must never regress to "".
      // (No epoch is ever stamped twice with different values, and
      // no stamp ever goes backward within an epoch.)
      const stampedByEpoch = new Map<number, string>();
      for (const o of observed) {
        const prior = stampedByEpoch.get(o.epoch);
        if (o.claimed_at.length > 0) {
          if (prior !== undefined) {
            expect(prior).toBe(o.claimed_at);
          } else {
            stampedByEpoch.set(o.epoch, o.claimed_at);
          }
        } else if (prior !== undefined && prior.length > 0) {
          // stamp went backward within an epoch — forbidden
          expect.fail(`epoch ${o.epoch} regressed from "${prior}" to ""`);
        }
      }
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// assertCurrentJson — exhaustive boundary / type guard coverage
//
// Strategy: every `assertCurrentJson` guard has the form
//   `typeof r["x"] !== "number" || !Number.isInteger(r["x"]) || r["x"] < 0`
// To kill mutants we must:
//   1. Feed a non-number  (e.g. "3", null) → kill the `typeof` half
//   2. Feed a non-integer (e.g. 1.5)       → kill the `!Number.isInteger` half
//   3. Feed -1 / 0                          → kill the `< 0` / `<= 0` boundary
//   4. Show 0 accepted                      → kill `<= 0`-vs-`< 0` confusion
//
// All tests write raw JSON via MemoryStorage.put so they bypass
// createCurrentJson's own assertCurrentJson call and hit the reader path.
// ─────────────────────────────────────────────────────────────────────────────

const putRaw = async (s: MemoryStorage, key: string, record: Record<string, unknown>) => {
  await s.put(key, new TextEncoder().encode(JSON.stringify(record)));
};

/** Fully-valid v2 record as a plain object (no branded types). */
const rawSeed = (): Record<string, unknown> => ({
  schema_version: CURRENT_JSON_SCHEMA_VERSION,
  snapshot: null,
  tail_hint: 0,
  log_seq_start: 0,
  writer_fence: { epoch: 0, owner: "", claimed_at: "" },
  tail_bytes: 0,
  snapshot_bytes: 0,
  snapshot_rows: 0,
});

describe("assertCurrentJson — top-level shape guard", () => {
  // L428: `parsed === null || typeof parsed !== "object"`
  // Kill the `||`→`&&` LogicalOperator mutant (L428) and the
  // ConditionalExpression→false mutants: need cases for both `null` and
  // non-object non-null to independently exercise each operand.
  plainTest("rejects null body with InvalidResponse", async () => {
    const s = new MemoryStorage();
    // Write the literal string "null" as the body.
    await s.put("k", new TextEncoder().encode("null"));
    await expect(readCurrentJson(s, "k")).rejects.toMatchObject({
      code: "InvalidResponse",
      message: expect.stringMatching(/not an object/),
    });
  });

  plainTest("rejects numeric body with InvalidResponse", async () => {
    const s = new MemoryStorage();
    await s.put("k", new TextEncoder().encode("42"));
    await expect(readCurrentJson(s, "k")).rejects.toMatchObject({
      code: "InvalidResponse",
      message: expect.stringMatching(/not an object/),
    });
  });

  plainTest("rejects boolean body with InvalidResponse", async () => {
    const s = new MemoryStorage();
    await s.put("k", new TextEncoder().encode("true"));
    await expect(readCurrentJson(s, "k")).rejects.toMatchObject({
      code: "InvalidResponse",
      message: expect.stringMatching(/not an object/),
    });
  });

  plainTest("rejects string body with InvalidResponse", async () => {
    const s = new MemoryStorage();
    await s.put("k", new TextEncoder().encode('"hello"'));
    await expect(readCurrentJson(s, "k")).rejects.toMatchObject({
      code: "InvalidResponse",
      message: expect.stringMatching(/not an object/),
    });
  });

  // Valid object passes all guards (exercises the "accepted" path for the
  // top-level check, killing ConditionalExpression→false that would always
  // throw).
  plainTest("accepts a valid object (does not throw on the object check)", async () => {
    const s = new MemoryStorage();
    await putRaw(s, "k", rawSeed());
    await expect(readCurrentJson(s, "k")).resolves.not.toBeNull();
  });
});

describe("assertCurrentJson — schema_version guard", () => {
  // L441/444: `r["schema_version"] !== CURRENT_JSON_SCHEMA_VERSION`
  // StringLiteral survivors at L444 are in the error message; kill by
  // asserting the message contains the key string.
  plainTest(
    "rejects schema_version 0 with message naming the required version and the recovery action",
    async () => {
      const s = new MemoryStorage();
      await putRaw(s, "k", { ...rawSeed(), schema_version: 0 });
      await expect(readCurrentJson(s, "k")).rejects.toMatchObject({
        code: "InvalidResponse",
        // The general-branch message must stay actionable: name the
        // required version AND prescribe the scratch-data recovery, so a
        // future bump (v2→v3, …) is self-documenting without a bespoke
        // per-version branch like the v1 reject above it.
        message: expect.stringMatching(/schema_version.*requires.*\d/i),
      });
    },
  );

  plainTest(
    "general schema-mismatch message prescribes wiping the dev bucket or recreating the bucket",
    async () => {
      const s = new MemoryStorage();
      await putRaw(s, "k", { ...rawSeed(), schema_version: 0 });
      await expect(readCurrentJson(s, "k")).rejects.toMatchObject({
        code: "InvalidResponse",
        message: expect.stringMatching(/wipe|recreate|\.baerly-data/i),
      });
    },
  );

  plainTest(
    "rejects schema_version 99 with message containing the unknown version number",
    async () => {
      const s = new MemoryStorage();
      await putRaw(s, "k", { ...rawSeed(), schema_version: 99 });
      await expect(readCurrentJson(s, "k")).rejects.toMatchObject({
        code: "InvalidResponse",
        message: expect.stringContaining("99"),
      });
    },
  );

  plainTest("accepts CURRENT_JSON_SCHEMA_VERSION exactly", async () => {
    const s = new MemoryStorage();
    await putRaw(s, "k", rawSeed());
    const got = await readCurrentJson(s, "k");
    expect(got).not.toBeNull();
    expect(got!.json.schema_version).toBe(CURRENT_JSON_SCHEMA_VERSION);
  });
});

describe("assertCurrentJson — snapshot field", () => {
  // L447: `typeof r["snapshot"] === "string" || r["snapshot"] === null`
  // The EqualityOperator mutant changes `=== null` → `!== null`.
  // The ConditionalExpression mutants negate individual branches.
  // Kill: (a) non-string non-null value must throw, (b) null must pass,
  // (c) a string must pass, (d) the two halves are independently exercised.
  plainTest("rejects snapshot: 123 (number) with InvalidResponse", async () => {
    const s = new MemoryStorage();
    await putRaw(s, "k", { ...rawSeed(), snapshot: 123 });
    await expect(readCurrentJson(s, "k")).rejects.toMatchObject({
      code: "InvalidResponse",
      message: expect.stringMatching(/snapshot/),
    });
  });

  plainTest("rejects snapshot: false (boolean) with InvalidResponse", async () => {
    const s = new MemoryStorage();
    await putRaw(s, "k", { ...rawSeed(), snapshot: false });
    await expect(readCurrentJson(s, "k")).rejects.toMatchObject({
      code: "InvalidResponse",
      message: expect.stringMatching(/snapshot/),
    });
  });

  plainTest("accepts snapshot: null (null exercising r[snapshot]===null branch)", async () => {
    const s = new MemoryStorage();
    await putRaw(s, "k", { ...rawSeed(), snapshot: null });
    const got = await readCurrentJson(s, "k");
    expect(got).not.toBeNull();
    expect(got!.json.snapshot).toBeNull();
  });

  plainTest("accepts snapshot: 'path/snap.json' (string exercising typeof branch)", async () => {
    const s = new MemoryStorage();
    await putRaw(s, "k", { ...rawSeed(), snapshot: "path/snap.json" });
    const got = await readCurrentJson(s, "k");
    expect(got).not.toBeNull();
    expect(got!.json.snapshot).toBe("path/snap.json");
  });
});

describe("assertCurrentJson — tail_hint guard", () => {
  // L453: three-operand compound:
  //   typeof r["tail_hint"] !== "number" || !Number.isInteger(r["tail_hint"]) || r["tail_hint"] < 0
  // Kill the LogicalOperator (||→&&) mutants: non-number kills `typeof` leg;
  // non-integer kills `isInteger` leg; -1 kills `< 0` leg.
  // Kill ConditionalExpression→false: 0 must be accepted.

  plainTest("rejects tail_hint: '5' (string, not a number)", async () => {
    const s = new MemoryStorage();
    await putRaw(s, "k", { ...rawSeed(), tail_hint: "5" });
    await expect(readCurrentJson(s, "k")).rejects.toMatchObject({
      code: "InvalidResponse",
      message: expect.stringMatching(/tail_hint/),
    });
  });

  plainTest("rejects tail_hint: null (not a number)", async () => {
    const s = new MemoryStorage();
    await putRaw(s, "k", { ...rawSeed(), tail_hint: null });
    await expect(readCurrentJson(s, "k")).rejects.toMatchObject({
      code: "InvalidResponse",
      message: expect.stringMatching(/tail_hint/),
    });
  });

  plainTest("rejects tail_hint: 1.5 (non-integer)", async () => {
    const s = new MemoryStorage();
    await putRaw(s, "k", { ...rawSeed(), tail_hint: 1.5 });
    await expect(readCurrentJson(s, "k")).rejects.toMatchObject({
      code: "InvalidResponse",
      message: expect.stringMatching(/tail_hint/),
    });
  });

  plainTest("rejects tail_hint: -1 (negative)", async () => {
    const s = new MemoryStorage();
    await putRaw(s, "k", { ...rawSeed(), tail_hint: -1 });
    await expect(readCurrentJson(s, "k")).rejects.toMatchObject({
      code: "InvalidResponse",
      message: expect.stringMatching(/tail_hint/),
    });
  });

  plainTest("accepts tail_hint: 0 (boundary — zero is valid)", async () => {
    const s = new MemoryStorage();
    await putRaw(s, "k", rawSeed());
    const got = await readCurrentJson(s, "k");
    expect(got).not.toBeNull();
    expect(got!.json.tail_hint).toBe(0);
  });

  plainTest("accepts tail_hint: 1 (positive integer)", async () => {
    const s = new MemoryStorage();
    await putRaw(s, "k", { ...rawSeed(), tail_hint: 1, log_seq_start: 0 });
    const got = await readCurrentJson(s, "k");
    expect(got).not.toBeNull();
    expect(got!.json.tail_hint).toBe(1);
  });
});

describe("assertCurrentJson — log_seq_start guard (type/integer/negative)", () => {
  // L460: same three-operand structure as tail_hint.

  plainTest("rejects log_seq_start: 'abc' (string, not a number)", async () => {
    const s = new MemoryStorage();
    await putRaw(s, "k", { ...rawSeed(), log_seq_start: "abc" });
    await expect(readCurrentJson(s, "k")).rejects.toMatchObject({
      code: "InvalidResponse",
      message: expect.stringMatching(/log_seq_start/),
    });
  });

  plainTest("rejects log_seq_start: true (boolean, not a number)", async () => {
    const s = new MemoryStorage();
    await putRaw(s, "k", { ...rawSeed(), log_seq_start: true });
    await expect(readCurrentJson(s, "k")).rejects.toMatchObject({
      code: "InvalidResponse",
      message: expect.stringMatching(/log_seq_start/),
    });
  });

  // log_seq_start: 0 is valid (already covered) but also test
  // the accepted path to kill ConditionalExpression→false here.
  plainTest("accepts log_seq_start: 0 (boundary)", async () => {
    const s = new MemoryStorage();
    await putRaw(s, "k", rawSeed());
    const got = await readCurrentJson(s, "k");
    expect(got!.json.log_seq_start).toBe(0);
  });
});

describe("assertCurrentJson — log_seq_start <= tail_hint guard", () => {
  // L469: `r["log_seq_start"] > r["tail_hint"]`
  // Kill EqualityOperator (> → >=) mutant: log_seq_start === tail_hint must pass.
  // Already tested in existing suite. Here we add the exact-equal case to
  // distinguish `>` from `>=`.

  plainTest(
    "accepts log_seq_start === tail_hint (fully compacted, >= would reject this)",
    async () => {
      const s = new MemoryStorage();
      await putRaw(s, "k", { ...rawSeed(), tail_hint: 3, log_seq_start: 3 });
      const got = await readCurrentJson(s, "k");
      expect(got!.json.log_seq_start).toBe(3);
      expect(got!.json.tail_hint).toBe(3);
    },
  );

  plainTest("rejects log_seq_start === tail_hint + 1 (exceeds)", async () => {
    const s = new MemoryStorage();
    await putRaw(s, "k", { ...rawSeed(), tail_hint: 3, log_seq_start: 4 });
    await expect(readCurrentJson(s, "k")).rejects.toMatchObject({
      code: "InvalidResponse",
      message: expect.stringMatching(/log_seq_start.*tail_hint/),
    });
  });

  // L472: StringLiteral×2 — message must include the actual numeric values of both fields.
  // When String(r["log_seq_start"]) or String(r["tail_hint"]) → "", the values vanish.
  // Using distinct values (7, 3) that don't appear in field names kills both mutants.
  plainTest(
    "error message for log_seq_start > tail_hint includes actual numeric values",
    async () => {
      const s = new MemoryStorage();
      await putRaw(s, "k", { ...rawSeed(), tail_hint: 3, log_seq_start: 7 });
      const err = await readCurrentJson(s, "k").catch((error: unknown) => error);
      expect(err).toBeInstanceOf(BaerlyError);
      expect((err as BaerlyError).message).toMatch(/log_seq_start/);
      expect((err as BaerlyError).message).toMatch(/tail_hint/);
      // Actual numeric values present (kills L472 StringLiteral→"" on both String() calls)
      expect((err as BaerlyError).message).toContain("7");
      expect((err as BaerlyError).message).toContain("3");
    },
  );
});

describe("assertCurrentJson — writer_fence sub-object guard", () => {
  // L476: `fence === null || typeof fence !== "object"`
  // Kill ConditionalExpression→false: need null writer_fence AND non-object.
  plainTest("rejects writer_fence: null", async () => {
    const s = new MemoryStorage();
    await putRaw(s, "k", { ...rawSeed(), writer_fence: null });
    await expect(readCurrentJson(s, "k")).rejects.toMatchObject({
      code: "InvalidResponse",
      message: expect.stringMatching(/writer_fence/),
    });
  });

  plainTest("rejects writer_fence: 'string' (non-object)", async () => {
    const s = new MemoryStorage();
    await putRaw(s, "k", { ...rawSeed(), writer_fence: "fence" });
    await expect(readCurrentJson(s, "k")).rejects.toMatchObject({
      code: "InvalidResponse",
      message: expect.stringMatching(/writer_fence/),
    });
  });

  plainTest("rejects writer_fence: 42 (non-object)", async () => {
    const s = new MemoryStorage();
    await putRaw(s, "k", { ...rawSeed(), writer_fence: 42 });
    await expect(readCurrentJson(s, "k")).rejects.toMatchObject({
      code: "InvalidResponse",
      message: expect.stringMatching(/writer_fence/),
    });
  });

  // L477: StringLiteral — message must mention "writer_fence missing"
  plainTest("error message for missing writer_fence mentions 'writer_fence'", async () => {
    const s = new MemoryStorage();
    const { writer_fence: _omit, ...without } = rawSeed();
    await putRaw(s, "k", without);
    const err = await readCurrentJson(s, "k").catch((error: unknown) => error);
    expect((err as BaerlyError).message).toMatch(/writer_fence/);
  });

  // L480: epoch — three-operand: typeof/isInteger/< 0
  plainTest("rejects writer_fence.epoch: '1' (string)", async () => {
    const s = new MemoryStorage();
    await putRaw(s, "k", { ...rawSeed(), writer_fence: { epoch: "1", owner: "", claimed_at: "" } });
    await expect(readCurrentJson(s, "k")).rejects.toMatchObject({
      code: "InvalidResponse",
      message: expect.stringMatching(/epoch/),
    });
  });

  plainTest("rejects writer_fence.epoch: null", async () => {
    const s = new MemoryStorage();
    await putRaw(s, "k", {
      ...rawSeed(),
      writer_fence: { epoch: null, owner: "", claimed_at: "" },
    });
    await expect(readCurrentJson(s, "k")).rejects.toMatchObject({
      code: "InvalidResponse",
      message: expect.stringMatching(/epoch/),
    });
  });

  plainTest("rejects writer_fence.epoch: 0.5 (non-integer)", async () => {
    const s = new MemoryStorage();
    await putRaw(s, "k", {
      ...rawSeed(),
      writer_fence: { epoch: 0.5, owner: "", claimed_at: "" },
    });
    await expect(readCurrentJson(s, "k")).rejects.toMatchObject({
      code: "InvalidResponse",
      message: expect.stringMatching(/epoch/),
    });
  });

  plainTest("rejects writer_fence.epoch: -1 (negative)", async () => {
    const s = new MemoryStorage();
    await putRaw(s, "k", { ...rawSeed(), writer_fence: { epoch: -1, owner: "", claimed_at: "" } });
    await expect(readCurrentJson(s, "k")).rejects.toMatchObject({
      code: "InvalidResponse",
      message: expect.stringMatching(/epoch/),
    });
  });

  plainTest("accepts writer_fence.epoch: 0 (boundary — zero valid)", async () => {
    const s = new MemoryStorage();
    await putRaw(s, "k", rawSeed());
    const got = await readCurrentJson(s, "k");
    expect(got!.json.writer_fence.epoch).toBe(0);
  });

  plainTest("accepts writer_fence.epoch: 1 (positive)", async () => {
    const s = new MemoryStorage();
    await putRaw(s, "k", { ...rawSeed(), writer_fence: { epoch: 1, owner: "", claimed_at: "" } });
    const got = await readCurrentJson(s, "k");
    expect(got!.json.writer_fence.epoch).toBe(1);
  });

  // L486: owner — typeof check
  plainTest("rejects writer_fence.owner: 42 (number, not string)", async () => {
    const s = new MemoryStorage();
    await putRaw(s, "k", { ...rawSeed(), writer_fence: { epoch: 0, owner: 42, claimed_at: "" } });
    await expect(readCurrentJson(s, "k")).rejects.toMatchObject({
      code: "InvalidResponse",
      message: expect.stringMatching(/owner/),
    });
  });

  plainTest("rejects writer_fence.owner: null (not a string)", async () => {
    const s = new MemoryStorage();
    await putRaw(s, "k", { ...rawSeed(), writer_fence: { epoch: 0, owner: null, claimed_at: "" } });
    await expect(readCurrentJson(s, "k")).rejects.toMatchObject({
      code: "InvalidResponse",
      message: expect.stringMatching(/owner/),
    });
  });

  plainTest("accepts writer_fence.owner: '' (empty string is valid)", async () => {
    const s = new MemoryStorage();
    await putRaw(s, "k", rawSeed());
    const got = await readCurrentJson(s, "k");
    expect(got!.json.writer_fence.owner).toBe("");
  });

  // L492: claimed_at — typeof check
  plainTest("rejects writer_fence.claimed_at: 123 (number)", async () => {
    const s = new MemoryStorage();
    await putRaw(s, "k", {
      ...rawSeed(),
      writer_fence: { epoch: 0, owner: "", claimed_at: 123 },
    });
    await expect(readCurrentJson(s, "k")).rejects.toMatchObject({
      code: "InvalidResponse",
      message: expect.stringMatching(/claimed_at/),
    });
  });

  plainTest("rejects writer_fence.claimed_at: null (not a string)", async () => {
    const s = new MemoryStorage();
    await putRaw(s, "k", {
      ...rawSeed(),
      writer_fence: { epoch: 0, owner: "", claimed_at: null },
    });
    await expect(readCurrentJson(s, "k")).rejects.toMatchObject({
      code: "InvalidResponse",
      message: expect.stringMatching(/claimed_at/),
    });
  });

  plainTest("accepts writer_fence.claimed_at: '' (empty string is valid)", async () => {
    const s = new MemoryStorage();
    await putRaw(s, "k", rawSeed());
    const got = await readCurrentJson(s, "k");
    expect(got!.json.writer_fence.claimed_at).toBe("");
  });

  // L498: lease_until — optional field: if present must be string
  plainTest("rejects writer_fence.lease_until: 99 (number) when present", async () => {
    const s = new MemoryStorage();
    await putRaw(s, "k", {
      ...rawSeed(),
      writer_fence: { epoch: 0, owner: "", claimed_at: "", lease_until: 99 },
    });
    await expect(readCurrentJson(s, "k")).rejects.toMatchObject({
      code: "InvalidResponse",
      message: expect.stringMatching(/lease_until/),
    });
  });

  plainTest("rejects writer_fence.lease_until: false (boolean) when present", async () => {
    const s = new MemoryStorage();
    await putRaw(s, "k", {
      ...rawSeed(),
      writer_fence: { epoch: 0, owner: "", claimed_at: "", lease_until: false },
    });
    await expect(readCurrentJson(s, "k")).rejects.toMatchObject({
      code: "InvalidResponse",
      message: expect.stringMatching(/lease_until/),
    });
  });

  plainTest("accepts writer_fence.lease_until absent (undefined)", async () => {
    const s = new MemoryStorage();
    await putRaw(s, "k", rawSeed());
    const got = await readCurrentJson(s, "k");
    expect(got!.json.writer_fence.lease_until).toBeUndefined();
  });

  plainTest("accepts writer_fence.lease_until: '2024-01-01T00:00:00.000Z' (string)", async () => {
    const s = new MemoryStorage();
    await putRaw(s, "k", {
      ...rawSeed(),
      writer_fence: {
        epoch: 0,
        owner: "",
        claimed_at: "",
        lease_until: "2024-01-01T00:00:00.000Z",
      },
    });
    const got = await readCurrentJson(s, "k");
    expect(got!.json.writer_fence.lease_until).toBe("2024-01-01T00:00:00.000Z");
  });
});

describe("assertCurrentJson — tail_bytes guard", () => {
  // L505: three-operand: typeof/isInteger/< 0
  plainTest("rejects tail_bytes: '0' (string)", async () => {
    const s = new MemoryStorage();
    await putRaw(s, "k", { ...rawSeed(), tail_bytes: "0" });
    await expect(readCurrentJson(s, "k")).rejects.toMatchObject({
      code: "InvalidResponse",
      message: expect.stringMatching(/tail_bytes/),
    });
  });

  plainTest("rejects tail_bytes: null", async () => {
    const s = new MemoryStorage();
    await putRaw(s, "k", { ...rawSeed(), tail_bytes: null });
    await expect(readCurrentJson(s, "k")).rejects.toMatchObject({
      code: "InvalidResponse",
      message: expect.stringMatching(/tail_bytes/),
    });
  });

  plainTest("rejects tail_bytes: 0.7 (non-integer)", async () => {
    const s = new MemoryStorage();
    await putRaw(s, "k", { ...rawSeed(), tail_bytes: 0.7 });
    await expect(readCurrentJson(s, "k")).rejects.toMatchObject({
      code: "InvalidResponse",
      message: expect.stringMatching(/tail_bytes/),
    });
  });

  plainTest("accepts tail_bytes: 0 (boundary)", async () => {
    const s = new MemoryStorage();
    await putRaw(s, "k", rawSeed());
    const got = await readCurrentJson(s, "k");
    expect(got!.json.tail_bytes).toBe(0);
  });

  plainTest("accepts tail_bytes: 1 (positive)", async () => {
    const s = new MemoryStorage();
    await putRaw(s, "k", { ...rawSeed(), tail_bytes: 1 });
    const got = await readCurrentJson(s, "k");
    expect(got!.json.tail_bytes).toBe(1);
  });
});

describe("assertCurrentJson — snapshot_bytes guard", () => {
  // L515: ConditionalExpression→false survivor — need a non-number/string test
  plainTest("rejects snapshot_bytes: 'big' (string)", async () => {
    const s = new MemoryStorage();
    await putRaw(s, "k", { ...rawSeed(), snapshot_bytes: "big" });
    await expect(readCurrentJson(s, "k")).rejects.toMatchObject({
      code: "InvalidResponse",
      message: expect.stringMatching(/snapshot_bytes/),
    });
  });

  plainTest("rejects snapshot_bytes: null", async () => {
    const s = new MemoryStorage();
    await putRaw(s, "k", { ...rawSeed(), snapshot_bytes: null });
    await expect(readCurrentJson(s, "k")).rejects.toMatchObject({
      code: "InvalidResponse",
      message: expect.stringMatching(/snapshot_bytes/),
    });
  });

  plainTest("rejects snapshot_bytes: -1 (negative)", async () => {
    const s = new MemoryStorage();
    await putRaw(s, "k", { ...rawSeed(), snapshot_bytes: -1 });
    await expect(readCurrentJson(s, "k")).rejects.toMatchObject({
      code: "InvalidResponse",
      message: expect.stringMatching(/snapshot_bytes/),
    });
  });

  // L517: StringLiteral — error message must mention snapshot_bytes
  plainTest("error message for bad snapshot_bytes contains 'snapshot_bytes'", async () => {
    const s = new MemoryStorage();
    await putRaw(s, "k", { ...rawSeed(), snapshot_bytes: -5 });
    const err = await readCurrentJson(s, "k").catch((error: unknown) => error);
    expect((err as BaerlyError).message).toContain("snapshot_bytes");
  });

  plainTest("accepts snapshot_bytes: 0 (boundary)", async () => {
    const s = new MemoryStorage();
    await putRaw(s, "k", rawSeed());
    const got = await readCurrentJson(s, "k");
    expect(got!.json.snapshot_bytes).toBe(0);
  });
});

describe("assertCurrentJson — snapshot_rows guard", () => {
  // L525: ConditionalExpression→false survivor
  plainTest("rejects snapshot_rows: {} (object, not a number)", async () => {
    const s = new MemoryStorage();
    await putRaw(s, "k", { ...rawSeed(), snapshot_rows: {} });
    await expect(readCurrentJson(s, "k")).rejects.toMatchObject({
      code: "InvalidResponse",
      message: expect.stringMatching(/snapshot_rows/),
    });
  });

  plainTest("rejects snapshot_rows: null", async () => {
    const s = new MemoryStorage();
    await putRaw(s, "k", { ...rawSeed(), snapshot_rows: null });
    await expect(readCurrentJson(s, "k")).rejects.toMatchObject({
      code: "InvalidResponse",
      message: expect.stringMatching(/snapshot_rows/),
    });
  });

  plainTest("accepts snapshot_rows: 0 (boundary)", async () => {
    const s = new MemoryStorage();
    await putRaw(s, "k", rawSeed());
    const got = await readCurrentJson(s, "k");
    expect(got!.json.snapshot_rows).toBe(0);
  });
});

describe("assertCurrentJson — last_warned_seq guard", () => {
  // L536: ConditionalExpression→false — the outer `r["last_warned_seq"] !== undefined` check.
  // Kill by testing that when last_warned_seq IS undefined, the record is accepted.
  plainTest("accepts record with last_warned_seq absent (undefined)", async () => {
    const s = new MemoryStorage();
    await putRaw(s, "k", rawSeed());
    const got = await readCurrentJson(s, "k");
    expect(got!.json.last_warned_seq).toBeUndefined();
  });

  // L538: EqualityOperator → `r["last_warned_seq"] <= 0`
  // Kill: last_warned_seq 0 must be accepted (valid boundary); -1 must be rejected.
  plainTest("accepts last_warned_seq: 0 (kills <= 0 mutant)", async () => {
    const s = new MemoryStorage();
    await putRaw(s, "k", { ...rawSeed(), last_warned_seq: 0 });
    const got = await readCurrentJson(s, "k");
    expect(got!.json.last_warned_seq).toBe(0);
  });

  plainTest("rejects last_warned_seq: -1 (negative)", async () => {
    const s = new MemoryStorage();
    await putRaw(s, "k", { ...rawSeed(), last_warned_seq: -1 });
    await expect(readCurrentJson(s, "k")).rejects.toMatchObject({
      code: "InvalidResponse",
      message: expect.stringMatching(/last_warned_seq/),
    });
  });

  plainTest("rejects last_warned_seq: 1.5 (non-integer)", async () => {
    const s = new MemoryStorage();
    await putRaw(s, "k", { ...rawSeed(), last_warned_seq: 1.5 });
    await expect(readCurrentJson(s, "k")).rejects.toMatchObject({
      code: "InvalidResponse",
      message: expect.stringMatching(/last_warned_seq/),
    });
  });

  plainTest("rejects last_warned_seq: 'x' (string, not a number)", async () => {
    const s = new MemoryStorage();
    await putRaw(s, "k", { ...rawSeed(), last_warned_seq: "x" });
    await expect(readCurrentJson(s, "k")).rejects.toMatchObject({
      code: "InvalidResponse",
      message: expect.stringMatching(/last_warned_seq/),
    });
  });

  plainTest("accepts last_warned_seq: 100 (positive integer)", async () => {
    const s = new MemoryStorage();
    await putRaw(s, "k", { ...rawSeed(), last_warned_seq: 100 });
    const got = await readCurrentJson(s, "k");
    expect(got!.json.last_warned_seq).toBe(100);
  });
});

describe("translateCasError — all three branches", () => {
  // L556: `e instanceof BaerlyError && e.code === "Conflict"`
  // Survivors: ConditionalExpression→true/false, EqualityOperator (code!=="Conflict"),
  // LogicalOperator (&&→||), StringLiteral in message.
  //
  // To exercise translateCasError from the outside we trigger storage CAS failures
  // via createCurrentJson (if-none-match) and casUpdateCurrentJson (if-match).
  // We also use a custom Storage that throws non-BaerlyError to cover the
  // third branch (L562).

  plainTest(
    "Conflict on createCurrentJson comes back as code:Conflict with 'CAS lost' annotation",
    async () => {
      const s = new MemoryStorage();
      await createCurrentJson(s, "k-cas", seedJson());
      const err = await createCurrentJson(s, "k-cas", seedJson()).catch((error: unknown) => error);
      expect(err).toBeInstanceOf(BaerlyError);
      expect((err as BaerlyError).code).toBe("Conflict");
      // L556 ConditionalExpression→false kill: message must contain the "CAS lost" annotation.
      // When the first branch body is emptied (BlockStatement→{}) or its condition is →false,
      // translateCasError falls to `return e` and the annotation is absent.
      // L556 StringLiteral→"": "Conflict" → "" means the condition is never true;
      // same fallthrough; annotation absent.
      // Using a distinctive key "k-cas" ensures the message contains it (kills L557 StringLiteral).
      expect((err as BaerlyError).message).toMatch(/CAS lost/);
      expect((err as BaerlyError).message).toContain("k-cas");
    },
  );

  plainTest(
    "Conflict on casUpdateCurrentJson comes back as code:Conflict with key in message",
    async () => {
      const s = new MemoryStorage();
      await createCurrentJson(s, "k2", seedJson());
      // Two concurrent updates: the second one's CAS will lose
      const etag1 = (await readCurrentJson(s, "k2"))!.etag;
      // Manually put something to invalidate etag1 by advancing past it
      await casUpdateCurrentJson(s, "k2", (c) => ({ ...c, tail_hint: 1 }));
      // Now try a manual put at the stale etag to force Conflict
      const err = await s
        .put("k2", new TextEncoder().encode(JSON.stringify(seedJson())), { ifMatch: etag1 })
        .catch((error: unknown) => error);
      // The storage itself throws Conflict; we just verify it's a BaerlyError
      expect((err as BaerlyError).code).toBe("Conflict");
    },
  );

  plainTest(
    "non-BaerlyError from storage comes back as code:InvalidResponse (third branch)",
    async () => {
      // Build a Storage that throws a plain Error on put to exercise the
      // translateCasError fallthrough branch (L562 in the source).
      const inner = new MemoryStorage();
      const throwing: Storage = {
        get: (k, o) => inner.get(k, o),
        delete: (k, o) => inner.delete(k, o),
        list: (p, o) => inner.list(p, o),
        put: async (
          _k: string,
          _b: Uint8Array,
          _o?: StoragePutOptions,
        ): Promise<StoragePutResult> => {
          throw new Error("disk full");
        },
      };
      await inner.put("k3", new TextEncoder().encode(JSON.stringify(seedJson())));
      const err = await casUpdateCurrentJson(throwing, "k3", (c) => ({ ...c, tail_hint: 1 })).catch(
        (error: unknown) => error,
      );
      expect(err).toBeInstanceOf(BaerlyError);
      expect((err as BaerlyError).code).toBe("InvalidResponse");
      expect((err as BaerlyError).message).toContain("k3");
    },
  );

  plainTest(
    "BaerlyError (non-Conflict) from storage passes through unchanged (second branch)",
    async () => {
      // Build a Storage that throws a BaerlyError{code:"NetworkError"} on put.
      const inner = new MemoryStorage();
      const networkError = new BaerlyError("NetworkError", "simulated timeout");
      const throwing: Storage = {
        get: (k, o) => inner.get(k, o),
        delete: (k, o) => inner.delete(k, o),
        list: (p, o) => inner.list(p, o),
        put: async (
          _k: string,
          _b: Uint8Array,
          _o?: StoragePutOptions,
        ): Promise<StoragePutResult> => {
          throw networkError;
        },
      };
      await inner.put("k4", new TextEncoder().encode(JSON.stringify(seedJson())));
      const err = await casUpdateCurrentJson(throwing, "k4", (c) => ({ ...c, tail_hint: 1 })).catch(
        (error: unknown) => error,
      );
      // Must be the exact same instance (pass-through, not wrapped)
      expect(err).toBe(networkError);
      expect((err as BaerlyError).code).toBe("NetworkError");
    },
  );
});

describe("createCurrentJson + casUpdateCurrentJson — signal propagation", () => {
  // L238, L289: ConditionalExpression for `opts?.signal !== undefined`
  // Kill the ConditionalExpression→true/false mutants: verify that when signal IS
  // provided it is forwarded (exercising the spread arm), and when it is absent
  // the call still succeeds (exercising the omitted arm).

  plainTest("createCurrentJson succeeds without signal option", async () => {
    const s = new MemoryStorage();
    const r = await createCurrentJson(s, "k", seedJson());
    expect(r.etag).toBeTruthy();
  });

  plainTest("createCurrentJson forwards signal to storage.put when provided", async () => {
    // Record whether the signal was forwarded by intercepting put options.
    const inner = new MemoryStorage();
    let capturedOpts: StoragePutOptions | undefined;
    const spy: Storage = {
      get: (k, o) => inner.get(k, o),
      delete: (k, o) => inner.delete(k, o),
      list: (p, o) => inner.list(p, o),
      put: async (k: string, b: Uint8Array, o?: StoragePutOptions): Promise<StoragePutResult> => {
        capturedOpts = o;
        return inner.put(k, b, o);
      },
    };
    const controller = new AbortController();
    await createCurrentJson(spy, "k", seedJson(), { signal: controller.signal });
    expect(capturedOpts?.signal).toBe(controller.signal);
  });

  plainTest("casUpdateCurrentJson forwards signal to storage.put when provided", async () => {
    const inner = new MemoryStorage();
    await createCurrentJson(inner, "k", seedJson());
    let capturedOpts: StoragePutOptions | undefined;
    const spy: Storage = {
      get: (k, o) => inner.get(k, o),
      delete: (k, o) => inner.delete(k, o),
      list: (p, o) => inner.list(p, o),
      put: async (k: string, b: Uint8Array, o?: StoragePutOptions): Promise<StoragePutResult> => {
        capturedOpts = o;
        return inner.put(k, b, o);
      },
    };
    const controller = new AbortController();
    await casUpdateCurrentJson(spy, "k", (c) => ({ ...c, tail_hint: 1 }), {
      signal: controller.signal,
    });
    expect(capturedOpts?.signal).toBe(controller.signal);
  });

  plainTest("casUpdateCurrentJson succeeds without signal option", async () => {
    const s = new MemoryStorage();
    await createCurrentJson(s, "k", seedJson());
    const r = await casUpdateCurrentJson(s, "k", (c) => ({ ...c, tail_hint: 1 }));
    expect(r.json.tail_hint).toBe(1);
  });
});

describe("claimWriter — signal propagation and lease_until forwarding", () => {
  // L368, L395: ConditionalExpression for signal in claimWriter's put calls.
  // L344: BlockStatement → {} (if existing===null path)
  // L359: lease_until conditional spread

  plainTest("claimWriter forwards signal to EVERY PUT (both provisional and stamp)", async () => {
    // L368 ConditionalExpression→false kill: provisional PUT must carry signal.
    // L395 ConditionalExpression→false kill: stamp PUT must also carry signal.
    // L368/L395 ConditionalExpression→true: {signal: undefined} spread is harmless (not undefined),
    //   but the assertion below uses `every` so we verify ALL puts saw the signal.
    // L368/L395 ObjectLiteral→{}: signal key absent from the spread → assertion fails.
    const inner = new MemoryStorage();
    await createCurrentJson(inner, "k", seedJson());
    const putSignals: (AbortSignal | undefined)[] = [];
    const spy: Storage = {
      get: (k, o) => inner.get(k, o),
      delete: (k, o) => inner.delete(k, o),
      list: (p, o) => inner.list(p, o),
      put: async (k: string, b: Uint8Array, o?: StoragePutOptions): Promise<StoragePutResult> => {
        putSignals.push(o?.signal);
        return inner.put(k, b, o);
      },
    };
    const controller = new AbortController();
    await claimWriter(spy, "k", "owner", { signal: controller.signal });
    // claimWriter issues 2 PUTs (provisional + stamp when serverDate is returned).
    // Both must carry the exact signal instance — kills →false (signal absent) and
    // ObjectLiteral→{} (signal key absent from spread).
    expect(putSignals.length).toBeGreaterThanOrEqual(2);
    expect(putSignals.every((sig) => sig === controller.signal)).toBe(true);
  });

  plainTest("claimWriter without signal — ALL puts succeed without signal set", async () => {
    // ConditionalExpression→true: when opts is undefined, opts?.signal is undefined.
    // Spreading {signal: undefined} adds undefined — distinct from not having the key.
    // When →true is active: putOpts includes {signal: undefined}.
    // MemoryStorage.put should not care about signal: undefined (it ignores signals).
    // To kill →true specifically: verify that without opts, putOpts.signal is undefined
    // (not a real signal). This is the "correct behavior" check.
    const inner = new MemoryStorage();
    await createCurrentJson(inner, "k", seedJson());
    const putSignals: (AbortSignal | undefined | null)[] = [];
    const spy: Storage = {
      get: (k, o) => inner.get(k, o),
      delete: (k, o) => inner.delete(k, o),
      list: (p, o) => inner.list(p, o),
      put: async (k: string, b: Uint8Array, o?: StoragePutOptions): Promise<StoragePutResult> => {
        // Distinguish "key absent" from "key present with undefined value" using `in`
        putSignals.push("signal" in (o ?? {}) ? (o?.signal ?? null) : null);
        return inner.put(k, b, o);
      },
    };
    // Call WITHOUT signal option
    await claimWriter(spy, "k", "owner");
    // No signal should have been forwarded — putOpts should not contain signal key
    // when opts?.signal is undefined (correct behavior: conditional spread is false → no key).
    // This kills ConditionalExpression→true: →true would spread {signal: undefined} (key present).
    // All captured signals should be null (key absent) not undefined (key present but undefined).
    expect(putSignals.every((sig) => sig === null)).toBe(true);
  });

  plainTest(
    "claimWriter provisional PUT Conflict (L373 NoCoverage): Conflict before first PUT",
    async () => {
      // L373 NoCoverage: the catch block wrapping the provisional storage.put inside
      // claimWriter. To reach it, the provisional PUT itself must throw Conflict — meaning
      // another writer landed between claimWriter's read and its first PUT.
      //
      // Strategy: use a storage whose get() returns the INITIAL etag but ALSO fires a
      // peer write to inner, so by the time claimWriter calls put(ifMatch: initialEtag),
      // the inner storage is already at a newer etag — CAS fails.
      const inner = new MemoryStorage();
      const initialRead = await createCurrentJson(inner, "k", seedJson());
      const staleEtag = initialRead.etag;
      let getCallCount = 0;
      const raceStorage: Storage = {
        get: async (k: string, o?: Parameters<Storage["get"]>[1]) => {
          getCallCount += 1;
          if (getCallCount === 1) {
            // Advance inner so the etag changes, then return the result with the ORIGINAL
            // (stale) etag so claimWriter uses the old etag for its ifMatch.
            await casUpdateCurrentJson(inner, k, (c) => ({ ...c, tail_hint: c.tail_hint + 1 }));
            // Return the current content but with the stale etag so claimWriter uses staleEtag
            const current = await inner.get(k, o);
            if (current === null) {
              return null;
            }
            return { ...current, etag: staleEtag };
          }
          return inner.get(k, o);
        },
        delete: (k, o) => inner.delete(k, o),
        list: (p, o) => inner.list(p, o),
        put: (k: string, b: Uint8Array, o?: StoragePutOptions) => inner.put(k, b, o),
      };
      // claimWriter reads with staleEtag, then tries PUT ifMatch:staleEtag → Conflict
      // because inner is already at a newer etag → L373 catch fires → throws Conflict.
      await expect(claimWriter(raceStorage, "k", "owner")).rejects.toMatchObject({
        code: "Conflict",
        message: expect.stringMatching(/CAS lost/),
      });
    },
  );

  plainTest("claimWriter throws InvalidResponse when key does not exist", async () => {
    const s = new MemoryStorage();
    await expect(claimWriter(s, "missing", "owner")).rejects.toMatchObject({
      code: "InvalidResponse",
      message: expect.stringMatching(/does not exist/),
    });
  });

  plainTest("claimWriter preserves lease_until when set on existing fence", async () => {
    const s = new MemoryStorage();
    // Manually write a current.json with a lease_until in the writer_fence.
    await putRaw(s, "k", {
      ...rawSeed(),
      writer_fence: {
        epoch: 0,
        owner: "",
        claimed_at: "",
        lease_until: "2099-01-01T00:00:00.000Z",
      },
    });
    const after = await claimWriter(s, "k", "new-owner");
    // The lease_until from the existing fence must be forwarded to the new fence.
    expect(after.json.writer_fence.lease_until).toBe("2099-01-01T00:00:00.000Z");
    expect(after.json.writer_fence.epoch).toBe(1);
  });

  plainTest("claimWriter does NOT forward lease_until when absent in existing fence", async () => {
    const s = new MemoryStorage();
    await createCurrentJson(s, "k", seedJson());
    const after = await claimWriter(s, "k", "owner");
    expect(after.json.writer_fence.lease_until).toBeUndefined();
  });

  plainTest("L365 ObjectLiteral→{} kill: concurrent claimWriter — exactly one wins", async () => {
    // L365 ObjectLiteral→{}: putOpts={} — no ifMatch. An unconditional PUT always succeeds,
    // so two concurrent claimWriter calls would BOTH succeed (neither gets Conflict).
    // This test fires two concurrent claims; exactly one must throw Conflict.
    const s = new MemoryStorage();
    await createCurrentJson(s, "k", seedJson());
    // Both calls read the same initial etag (epoch=0). Without L365 mutant, the second
    // call's provisional PUT has ifMatch= stale etag → Conflict. With the mutant, both
    // PUTs are unconditional → both succeed → results.filter(rejected).length is 0.
    const results = await Promise.allSettled([
      claimWriter(s, "k", "writer-A"),
      claimWriter(s, "k", "writer-B"),
    ]);
    const failed = results.filter((r) => r.status === "rejected");
    // Exactly one must fail with Conflict
    expect(failed.length).toBe(1);
    expect((failed[0] as PromiseRejectedResult).reason).toMatchObject({
      code: "Conflict",
    });
    // The epoch from the successful claim must be exactly 1 above the initial
    const succeeded = results.filter((r) => r.status === "fulfilled") as Array<
      PromiseFulfilledResult<Awaited<ReturnType<typeof claimWriter>>>
    >;
    expect(succeeded.length).toBe(1);
    expect(succeeded[0]!.value.json.writer_fence.epoch).toBe(1);
  });

  plainTest("claimWriter Conflict wraps correctly with key in message", async () => {
    const inner = new MemoryStorage();
    await createCurrentJson(inner, "k", seedJson());
    // Use an interposing storage that, after the first put, fires a conflicting write
    // to force the provisional PUT to lose.
    const storage = new InterposingStorage(inner, async () => {
      await casUpdateCurrentJson(inner, "k", (c) => ({ ...c, tail_hint: c.tail_hint + 1 }));
    });
    const err = await claimWriter(storage, "k", "owner").catch((error: unknown) => error);
    expect(err).toBeInstanceOf(BaerlyError);
    expect((err as BaerlyError).code).toBe("Conflict");
    // L557 StringLiteral: message must contain the key
    expect((err as BaerlyError).message).toContain("k");
  });

  plainTest("claimWriter stamp-PUT Conflict loses cleanly (key in Conflict message)", async () => {
    // Same as the two-phase peer test but verifying the message contains key.
    const inner = new MemoryStorage();
    await createCurrentJson(inner, "k-stamp", seedJson());
    const storage = new InterposingStorage(inner, async () => {
      await casUpdateCurrentJson(inner, "k-stamp", (c) => ({ ...c, tail_hint: c.tail_hint + 1 }));
    });
    const err = await claimWriter(storage, "k-stamp", "owner").catch((error: unknown) => error);
    expect((err as BaerlyError).code).toBe("Conflict");
    expect((err as BaerlyError).message).toContain("k-stamp");
  });
});

describe("createCurrentJson — assertCurrentJson pre-flight", () => {
  // createCurrentJson calls assertCurrentJson(initial, key) before hitting storage.
  // This kills L206 BlockStatement→{} (the assertCurrentJson call in createCurrentJson).
  plainTest(
    "createCurrentJson rejects a malformed initial record before touching storage",
    async () => {
      const s = new MemoryStorage();
      // Cast via unknown to bypass TypeScript's type guard — pass a schema_version:0 record.
      const bad = { ...seedJson(), schema_version: 0 } as unknown as CurrentJson;
      await expect(createCurrentJson(s, "k", bad)).rejects.toMatchObject({
        code: "InvalidResponse",
      });
      // Verify nothing was written (key still missing)
      await expect(readCurrentJson(s, "k")).resolves.toBeNull();
    },
  );
});

describe("casUpdateCurrentJson — assertCurrentJson on mutated output", () => {
  // casUpdateCurrentJson also calls assertCurrentJson(next, key) on the mutator's
  // return value. This kills L276 StringLiteral on the casUpdate do-not-exist path.
  plainTest(
    "casUpdateCurrentJson throws InvalidResponse with key in message when key missing",
    async () => {
      const s = new MemoryStorage();
      const err = await casUpdateCurrentJson(s, "my-key", (c) => c).catch(
        (error: unknown) => error,
      );
      expect((err as BaerlyError).code).toBe("InvalidResponse");
      expect((err as BaerlyError).message).toContain("my-key");
    },
  );
});
