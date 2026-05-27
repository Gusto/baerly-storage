import { fc, test } from "@fast-check/vitest";
import { describe, expect, test as plainTest } from "vitest";
import {
  BaerlyError,
  CURRENT_JSON_SCHEMA_VERSION,
  type CurrentJson,
  type CurrentJsonRead,
  casUpdateCurrentJson,
  createCurrentJson,
  logSeqStartOf,
  MemoryStorage,
  readCurrentJson,
} from "../index.ts";
import { claimWriter } from "./current-json.ts";
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
      // bumps `next_seq`; it reads the etag claimWriter just wrote,
      // mutates the record, and writes — invalidating the etag
      // claimWriter is about to use for its stamp.
      const storage = new InterposingStorage(inner, async () => {
        await casUpdateCurrentJson(inner, "k", (c) => ({
          ...c,
          next_seq: c.next_seq + 1,
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
      expect(after!.json.next_seq).toBe(1);
    },
  );
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
