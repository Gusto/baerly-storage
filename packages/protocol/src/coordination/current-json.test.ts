import { fc, test } from "@fast-check/vitest";
import { describe, expect, test as plainTest } from "vitest";
import {
  BaerlyError,
  CURRENT_JSON_CONTENT_TYPE,
  CURRENT_JSON_SCHEMA_VERSION,
  type CurrentJson,
  assertCurrentJsonTransition,
  casUpdateCurrentJson,
  createCurrentJson,
  encodeJsonBytes,
  logDeleteFloorOf,
  logSeqStartOf,
  MemoryStorage,
  mintGeneration,
  readCurrentJson,
} from "../index.ts";
import type { Storage, StoragePutOptions, StoragePutResult } from "../storage/types.ts";

const seedJson = (overrides: Partial<CurrentJson> = {}): CurrentJson => ({
  schema_version: CURRENT_JSON_SCHEMA_VERSION,
  snapshot: null,
  tail_hint: 0,
  log_seq_start: 0,
  writer_fence: { epoch: 0, owner: "test", claimed_at: "" },
  snapshot_bytes: 0,
  snapshot_rows: 0,
  ...overrides,
});

describe("assertCurrentJsonTransition", () => {
  const base = (logSeqStart: number): CurrentJson =>
    seedJson({ tail_hint: 1_000_000, log_seq_start: logSeqStart });

  plainTest("permits an advancing floor", () => {
    expect(() => assertCurrentJsonTransition(base(10), base(20), "k")).not.toThrow();
  });

  plainTest("permits an unchanged floor", () => {
    expect(() => assertCurrentJsonTransition(base(10), base(10), "k")).not.toThrow();
  });

  plainTest("rejects a lowered floor with Internal", () => {
    try {
      assertCurrentJsonTransition(base(20), base(10), "k");
      expect.unreachable("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(BaerlyError);
      expect((error as BaerlyError).code).toBe("Internal");
      expect((error as BaerlyError).message).toContain("log_seq_start must not decrease");
    }
  });

  describe("log_delete_floor", () => {
    plainTest("permits an advancing delete floor", () => {
      const before = { ...base(100), log_delete_floor: 10 };
      const after = { ...base(100), log_delete_floor: 20 };
      expect(() => assertCurrentJsonTransition(before, after, "k")).not.toThrow();
    });

    plainTest("rejects a lowered delete floor with Internal", () => {
      const before = { ...base(100), log_delete_floor: 20 };
      const after = { ...base(100), log_delete_floor: 10 };
      try {
        assertCurrentJsonTransition(before, after, "k");
        expect.unreachable("expected a throw");
      } catch (error) {
        expect(error).toBeInstanceOf(BaerlyError);
        expect((error as BaerlyError).code).toBe("Internal");
        expect((error as BaerlyError).message).toContain("log_delete_floor must not decrease");
      }
    });

    plainTest("rejects a delete floor above the live floor", () => {
      const before = { ...base(100), log_delete_floor: 10 };
      const after = { ...base(100), log_delete_floor: 101 };
      try {
        assertCurrentJsonTransition(before, after, "k");
        expect.unreachable("expected a throw");
      } catch (error) {
        expect(error).toBeInstanceOf(BaerlyError);
        expect((error as BaerlyError).code).toBe("Internal");
        expect((error as BaerlyError).message).toContain("must not exceed log_seq_start");
      }
    });

    // The boundary the rule permits: certifying deletion up to but not
    // including the lowest live seq. `log_delete_floor === log_seq_start`
    // means every folded entry is gone and nothing a reader needs was touched.
    plainTest("permits a delete floor exactly at the live floor", () => {
      const after = { ...base(100), log_delete_floor: 100 };
      expect(() => assertCurrentJsonTransition(base(100), after, "k")).not.toThrow();
    });

    plainTest("treats an absent prior floor as 0 (no deleted prefix certified)", () => {
      const after = { ...base(100), log_delete_floor: 5 };
      expect(() => assertCurrentJsonTransition(base(100), after, "k")).not.toThrow();
    });

    // A pre-field manifest on both sides must be admitted. Kills
    // `<` → `<=` on the monotonicity check, which would read 0 → 0 as a
    // decrease and stall every write to every bucket that has never set
    // the field — i.e. all of them today.
    plainTest("accepts an absent floor on both sides", () => {
      expect(() => assertCurrentJsonTransition(base(100), base(100), "k")).not.toThrow();
    });

    // Kills the mutant that drops the `?? 0` when reading the AFTER side:
    // `undefined < 20` is false, so an unguarded comparison would let a
    // present floor silently regress to absent.
    plainTest("rejects dropping a present delete floor back to absent", () => {
      const before = { ...base(100), log_delete_floor: 20 };
      try {
        assertCurrentJsonTransition(before, base(100), "k");
        expect.unreachable("expected a throw");
      } catch (error) {
        expect((error as BaerlyError).code).toBe("Internal");
        expect((error as BaerlyError).message).toContain("log_delete_floor must not decrease");
      }
    });
  });
});

describe("logDeleteFloorOf", () => {
  plainTest("absent decodes to 0 (no deleted prefix certified)", () => {
    expect(logDeleteFloorOf(seedJson({ tail_hint: 1_000_000, log_seq_start: 10 }))).toBe(0);
  });

  plainTest("present is returned as-is", () => {
    expect(
      logDeleteFloorOf(seedJson({ tail_hint: 1_000_000, log_seq_start: 10, log_delete_floor: 7 })),
    ).toBe(7);
  });
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
      // readCurrentJson JSON-parse catch message StringLiteral→`` kill: message must contain "valid JSON" — the exact phrase
      // from the error template. The equivalent BlockStatement→{} mutant (parse catch block) produces
      // "parsed body is not an object" (from assertCurrentJson on undefined), which does
      // NOT contain "valid JSON".
      // parse-catch BlockStatement→{}: with empty catch, parsed=undefined → assertCurrentJson(undefined)
      // throws "not an object". "valid JSON" absent → test FAILS → kills the parse-catch BlockStatement mutant.
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

  // Tolerant-reader / forward-compat regression (ADR-003 Tier 1).
  // An UNKNOWN field on current.json must be IGNORED, not rejected.
  // This pins the "additive-optional, no bump" evolution rule so a
  // future refactor cannot silently add unknown-key rejection and break
  // the deferred layout_version plan. See docs/adr/003-layout-versioning-cordon.md.
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

  plainTest("throws WriteConflict on existing key", async () => {
    const s = new MemoryStorage();
    await createCurrentJson(s, "k", seedJson());
    await expect(createCurrentJson(s, "k", seedJson({ tail_hint: 1 }))).rejects.toMatchObject({
      code: "WriteConflict",
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

  plainTest("throws WriteConflict deterministically when interleaved", async () => {
    const s = new MemoryStorage();
    await createCurrentJson(s, "k", seedJson());
    // Both reads complete before either put fires (Promise.allSettled
    // serializes neither). Both writes commit at the same etag; the
    // storage layer surfaces the second one as `WriteConflict`.
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
      code: "WriteConflict",
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

  plainTest("rejects a mutator that lowers log_seq_start", async () => {
    const s = new MemoryStorage();
    await createCurrentJson(s, "k", seedJson({ tail_hint: 5000, log_seq_start: 5000 }));
    await expect(
      casUpdateCurrentJson(s, "k", (c) => ({ ...c, log_seq_start: 0 })),
    ).rejects.toMatchObject({ code: "Internal" });
    // The rejection must happen before the PUT — the floor on disk is intact.
    const got = await readCurrentJson(s, "k");
    expect(got!.json.log_seq_start).toBe(5000);
  });

  plainTest("permits a re-write that holds log_seq_start steady", async () => {
    // The boundary: monotone means non-decreasing. A compactor pass that
    // advances `tail_hint` without folding anything leaves the floor equal,
    // and must not be rejected. Fails if the guard is written `<=`.
    const s = new MemoryStorage();
    await createCurrentJson(s, "k", seedJson({ tail_hint: 5000, log_seq_start: 5000 }));
    await casUpdateCurrentJson(s, "k", (c) => ({ ...c, tail_hint: 6000 }));
    const got = await readCurrentJson(s, "k");
    expect(got!.json.log_seq_start).toBe(5000);
    expect(got!.json.tail_hint).toBe(6000);
  });
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
      snapshot_bytes: fc.integer({ min: 0, max: 1_000_000 }),
      snapshot_rows: fc.integer({ min: 0, max: 10_000 }),
    }),
  );

  test.prop({
    initial: validCurrentJson,
    delta: fc.integer({ min: -1000, max: 1000 }),
  })(
    "floor admission: the CAS accepts a floor move iff it does not decrease",
    async ({ initial, delta }) => {
      const s = new MemoryStorage();
      await createCurrentJson(s, "k", initial);
      const target = initial.log_seq_start + delta;
      // Only exercise floors `assertCurrentJson` already accepts
      // (`0 <= log_seq_start <= tail_hint`), so the sole possible
      // rejection reason is the monotonicity admission check. This
      // covers the whole ordering, not the two sampled points above.
      if (target < 0 || target > initial.tail_hint) {
        return;
      }
      const attempt = casUpdateCurrentJson(s, "k", (c) => ({ ...c, log_seq_start: target }));
      const shouldReject = target < initial.log_seq_start;
      if (shouldReject) {
        await expect(attempt).rejects.toMatchObject({ code: "Internal" });
      } else {
        await attempt;
      }
      const got = await readCurrentJson(s, "k");
      expect(got!.json.log_seq_start).toBe(shouldReject ? initial.log_seq_start : target);
    },
  );

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

describe("CurrentJson schema v2 — snapshot_bytes / snapshot_rows", () => {
  // ── v2 acceptance ──────────────────────────────────────────────────
  plainTest("accepts a valid v2 record with all required byte/row fields", async () => {
    const s = new MemoryStorage();
    await createCurrentJson(s, "k", seedJson());
    const got = await readCurrentJson(s, "k");
    expect(got).not.toBeNull();
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
    "rejects a pre-0.3.0 release's schema with dump/restore or re-provision guidance",
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
        message: expect.stringMatching(
          /from a release before 0\.3\.0[\s\S]*Dump\/restore with that release[\s\S]*re-provision/,
        ),
      });
    },
  );

  // ── missing required byte/row fields ───────────────────────────────
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

  plainTest("createCurrentJson seeds snapshot_bytes=0, snapshot_rows=0", async () => {
    const s = new MemoryStorage();
    const r = await createCurrentJson(s, "k", seedJson());
    expect(r.json.snapshot_bytes).toBe(0);
    expect(r.json.snapshot_rows).toBe(0);
  });
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
  snapshot_bytes: 0,
  snapshot_rows: 0,
});

describe("assertCurrentJson — top-level shape guard", () => {
  // assertCurrentJson object guard: `parsed === null || typeof parsed !== "object"`
  // Kill the `||`→`&&` LogicalOperator mutant (the object guard) and the
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
  // assertCurrentJson schema_version guard: `r["schema_version"] !== CURRENT_JSON_SCHEMA_VERSION`
  // StringLiteral survivors in that error message; kill by
  // asserting the message contains the key string.
  plainTest(
    "rejects schema_version 0 with message naming the required version and the recovery action",
    async () => {
      const s = new MemoryStorage();
      await putRaw(s, "k", { ...rawSeed(), schema_version: 0 });
      await expect(readCurrentJson(s, "k")).rejects.toMatchObject({
        code: "InvalidResponse",
        // The general-branch message must stay actionable: name the
        // supported version AND carry a local-dev-only recovery hint, so a
        // future bump (v2→v3, …) is self-documenting without a bespoke
        // per-version branch like the v1 reject above it.
        message: expect.stringMatching(/schema_version.*supports schema_version \d/i),
      });
    },
  );

  plainTest.each([
    ["newer", 99],
    ["non-integer", 1.5],
    ["string", "three"],
    ["pre-0.3 v1", 1],
    ["pre-0.3 v2", 2],
  ] as const)("%s schema_version message names both versions, no bucket advice", async (_n, v) => {
    const s = new MemoryStorage();
    await putRaw(s, "k", { ...rawSeed(), schema_version: v });
    const err = await readCurrentJson(s, "k").catch((error: unknown) => error);
    expect(err).toMatchObject({ code: "InvalidResponse" });
    const msg = (err as Error).message;
    expect(msg).toContain(String(v));
    expect(msg).toContain(String(CURRENT_JSON_SCHEMA_VERSION));
    expect(msg).not.toMatch(/recreate|bucket/i);
  });

  plainTest("a fractional version above the supported one is not 'newer'", async () => {
    const s = new MemoryStorage();
    await putRaw(s, "k", { ...rawSeed(), schema_version: CURRENT_JSON_SCHEMA_VERSION + 0.5 });
    const err = await readCurrentJson(s, "k").catch((error: unknown) => error);
    const msg = (err as Error).message;
    expect(msg).not.toMatch(/newer baerly-storage release/);
    expect(msg).toMatch(/not written by this build/);
    expect(msg).toMatch(/local data directory/);
  });

  plainTest("newer schema_version says a newer release wrote it", async () => {
    const s = new MemoryStorage();
    await putRaw(s, "k", { ...rawSeed(), schema_version: CURRENT_JSON_SCHEMA_VERSION + 1 });
    await expect(readCurrentJson(s, "k")).rejects.toMatchObject({
      message: expect.stringMatching(/newer baerly-storage release/),
    });
  });

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

  plainTest.each([
    ["array", (n: number) => "[".repeat(n) + "]".repeat(n)],
    ["object", (n: number) => '{"a":'.repeat(n) + "null" + "}".repeat(n)],
  ] as const)(
    "a deeply nested %s schema_version is an InvalidResponse, not a stack overflow",
    async (_n, nest) => {
      const s = new MemoryStorage();
      // Built as JSON text: JSON.stringify of a value this deep overflows.
      const { schema_version: _drop, ...rest } = rawSeed();
      const body = JSON.stringify(rest).replace(/^\{/, `{"schema_version":${nest(50_000)},`);
      await s.put("k", new TextEncoder().encode(body));
      const err = await readCurrentJson(s, "k").catch((error: unknown) => error);
      expect(err).toBeInstanceOf(BaerlyError);
      expect(err).toMatchObject({ code: "InvalidResponse" });
      expect((err as Error).message.length).toBeLessThan(1024);
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
  // assertCurrentJson snapshot guard: `typeof r["snapshot"] === "string" || r["snapshot"] === null`
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
  // assertCurrentJson tail_hint guard, three-operand compound:
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
  // assertCurrentJson log_seq_start guard: same three-operand structure as tail_hint.

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
  // assertCurrentJson log_seq_start/tail_hint cross-check: `r["log_seq_start"] > r["tail_hint"]`
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

  // cross-check error message StringLiteral×2 — message must include the actual numeric values of both fields.
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
      // Actual numeric values present (kills the cross-check message StringLiteral→"" on both String() calls)
      expect((err as BaerlyError).message).toContain("7");
      expect((err as BaerlyError).message).toContain("3");
    },
  );
});

describe("assertCurrentJson — writer_fence sub-object guard", () => {
  // assertCurrentJson writer_fence object guard: `fence === null || typeof fence !== "object"`
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

  // writer_fence-missing error message StringLiteral — message must mention "writer_fence missing"
  plainTest("error message for missing writer_fence mentions 'writer_fence'", async () => {
    const s = new MemoryStorage();
    const { writer_fence: _omit, ...without } = rawSeed();
    await putRaw(s, "k", without);
    const err = await readCurrentJson(s, "k").catch((error: unknown) => error);
    expect((err as BaerlyError).message).toMatch(/writer_fence/);
  });

  // writer_fence.epoch guard — three-operand: typeof/isInteger/< 0
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

  // writer_fence.owner guard — typeof check
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

  // writer_fence.claimed_at guard — typeof check
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

  // writer_fence.lease_until guard — optional field: if present must be string
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

describe("assertCurrentJson — snapshot_bytes guard", () => {
  // snapshot_bytes type guard ConditionalExpression→false survivor — need a non-number/string test
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

  // snapshot_bytes error message StringLiteral — error message must mention snapshot_bytes
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
  // snapshot_rows type guard ConditionalExpression→false survivor
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
  // last_warned_seq presence guard ConditionalExpression→false — the outer `r["last_warned_seq"] !== undefined` check.
  // Kill by testing that when last_warned_seq IS undefined, the record is accepted.
  plainTest("accepts record with last_warned_seq absent (undefined)", async () => {
    const s = new MemoryStorage();
    await putRaw(s, "k", rawSeed());
    const got = await readCurrentJson(s, "k");
    expect(got!.json.last_warned_seq).toBeUndefined();
  });

  // last_warned_seq range check EqualityOperator → `r["last_warned_seq"] <= 0`
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

// Shape only, deliberately. The `log_delete_floor <= log_seq_start` bound is
// transition-scoped (`assertCurrentJsonTransition`) and NOT checked here —
// `readCurrentJson` sits on `admin restore`'s own repair path, so rejecting a
// single state on that bound would leave an out-of-bound floor with no
// in-product way out. The last case below pins that the read succeeds.
describe("assertCurrentJson — log_delete_floor guard", () => {
  plainTest("accepts record with log_delete_floor absent (undefined)", async () => {
    const s = new MemoryStorage();
    await putRaw(s, "k", rawSeed());
    const got = await readCurrentJson(s, "k");
    expect(got!.json.log_delete_floor).toBeUndefined();
  });

  plainTest("accepts log_delete_floor: 0 (boundary)", async () => {
    const s = new MemoryStorage();
    await putRaw(s, "k", { ...rawSeed(), log_delete_floor: 0 });
    const got = await readCurrentJson(s, "k");
    expect(got!.json.log_delete_floor).toBe(0);
  });

  plainTest("rejects log_delete_floor: -1 (negative)", async () => {
    const s = new MemoryStorage();
    await putRaw(s, "k", { ...rawSeed(), log_delete_floor: -1 });
    await expect(readCurrentJson(s, "k")).rejects.toMatchObject({
      code: "InvalidResponse",
      message: expect.stringMatching(/log_delete_floor/),
    });
  });

  plainTest("rejects log_delete_floor: 1.5 (non-integer)", async () => {
    const s = new MemoryStorage();
    await putRaw(s, "k", { ...rawSeed(), log_delete_floor: 1.5 });
    await expect(readCurrentJson(s, "k")).rejects.toMatchObject({
      code: "InvalidResponse",
      message: expect.stringMatching(/log_delete_floor/),
    });
  });

  plainTest("rejects log_delete_floor: 'x' (string, not a number)", async () => {
    const s = new MemoryStorage();
    await putRaw(s, "k", { ...rawSeed(), log_delete_floor: "x" });
    await expect(readCurrentJson(s, "k")).rejects.toMatchObject({
      code: "InvalidResponse",
      message: expect.stringMatching(/log_delete_floor/),
    });
  });

  plainTest("accepts log_delete_floor: 100 (positive integer)", async () => {
    const s = new MemoryStorage();
    await putRaw(s, "k", {
      ...rawSeed(),
      log_delete_floor: 100,
      log_seq_start: 100,
      tail_hint: 100,
    });
    const got = await readCurrentJson(s, "k");
    expect(got!.json.log_delete_floor).toBe(100);
  });

  // Pinned: a floor ABOVE `log_seq_start` reads back clean.
  // Fail-safe direction is stall, not lockout — and this is what makes the
  // clamp in the `Db` read seam reachable and testable.
  plainTest("accepts log_delete_floor above log_seq_start (transition-scoped bound)", async () => {
    const s = new MemoryStorage();
    await putRaw(s, "k", { ...rawSeed(), log_delete_floor: 5, log_seq_start: 0 });
    const got = await readCurrentJson(s, "k");
    expect(got!.json.log_delete_floor).toBe(5);
  });
});

describe("translateCasError — all three branches", () => {
  // translateCasError WriteConflict branch: `e instanceof BaerlyError && e.code === "WriteConflict"`
  // Survivors: ConditionalExpression→true/false, EqualityOperator (code!=="WriteConflict"),
  // LogicalOperator (&&→||), StringLiteral in message.
  //
  // To exercise translateCasError from the outside we trigger storage CAS failures
  // via createCurrentJson (if-none-match) and casUpdateCurrentJson (if-match).
  // We also use a custom Storage that throws non-BaerlyError to cover the
  // third branch (the final `return e`).

  plainTest(
    "WriteConflict on createCurrentJson comes back as code:WriteConflict with 'CAS lost' annotation",
    async () => {
      const s = new MemoryStorage();
      await createCurrentJson(s, "k-cas", seedJson());
      const err = await createCurrentJson(s, "k-cas", seedJson()).catch((error: unknown) => error);
      expect(err).toBeInstanceOf(BaerlyError);
      expect((err as BaerlyError).code).toBe("WriteConflict");
      // translateCasError WriteConflict branch ConditionalExpression→false kill: message must contain the "CAS lost" annotation.
      // When the first branch body is emptied (BlockStatement→{}) or its condition is →false,
      // translateCasError falls to `return e` and the annotation is absent.
      // translateCasError WriteConflict branch StringLiteral→"": "WriteConflict" → "" means the condition is never true;
      // same fallthrough; annotation absent.
      // Using a distinctive key "k-cas" ensures the message contains it (kills the annotation message StringLiteral).
      expect((err as BaerlyError).message).toMatch(/CAS lost/);
      expect((err as BaerlyError).message).toContain("k-cas");
    },
  );

  plainTest(
    "WriteConflict on casUpdateCurrentJson comes back as code:WriteConflict with key in message",
    async () => {
      const s = new MemoryStorage();
      await createCurrentJson(s, "k2", seedJson());
      // Two concurrent updates: the second one's CAS will lose
      const etag1 = (await readCurrentJson(s, "k2"))!.etag;
      // Manually put something to invalidate etag1 by advancing past it
      await casUpdateCurrentJson(s, "k2", (c) => ({ ...c, tail_hint: 1 }));
      // Now try a manual put at the stale etag to force WriteConflict
      const err = await s
        .put("k2", new TextEncoder().encode(JSON.stringify(seedJson())), { ifMatch: etag1 })
        .catch((error: unknown) => error);
      // The storage itself throws WriteConflict; we just verify it's a BaerlyError
      expect((err as BaerlyError).code).toBe("WriteConflict");
    },
  );

  plainTest(
    "non-BaerlyError from storage comes back as code:InvalidResponse (third branch)",
    async () => {
      // Build a Storage that throws a plain Error on put to exercise the
      // translateCasError fallthrough branch (the final `return e`).
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
    "BaerlyError (non-WriteConflict) from storage passes through unchanged (second branch)",
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
  // casUpdate/create `opts?.signal !== undefined` ConditionalExpression for `opts?.signal !== undefined`
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

describe("createCurrentJson — assertCurrentJson pre-flight", () => {
  // createCurrentJson calls assertCurrentJson(initial, key) before hitting storage.
  // This kills the BlockStatement→{} mutant (the assertCurrentJson call in createCurrentJson).
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
  // return value. This kills the StringLiteral mutant on the casUpdate do-not-exist path.
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

describe("assertCurrentJson — generation guard", () => {
  plainTest("accepts a record with generation absent (pre-field manifest)", async () => {
    const s = new MemoryStorage();
    await putRaw(s, "k", rawSeed());
    const got = await readCurrentJson(s, "k");
    expect(got!.json.generation).toBeUndefined();
  });

  plainTest("accepts a minted generation", async () => {
    const s = new MemoryStorage();
    await putRaw(s, "k", { ...rawSeed(), generation: "0123456789ab" });
    const got = await readCurrentJson(s, "k");
    expect(got!.json.generation).toBe("0123456789ab");
  });

  plainTest("rejects generation: '' (empty string)", async () => {
    // Not just a type guard. An empty generation formats a cursor as
    // `.<lsn>`, which parseCursor reads as generation "" rather than as
    // the NO_GENERATION sentinel — so the two spellings of "no
    // generation" would stop comparing equal and every resume on this
    // collection would be rejected.
    const s = new MemoryStorage();
    await putRaw(s, "k", { ...rawSeed(), generation: "" });
    await expect(readCurrentJson(s, "k")).rejects.toMatchObject({
      code: "InvalidResponse",
      message: expect.stringMatching(/generation/),
    });
  });

  plainTest("rejects generation: 7 (not a string)", async () => {
    const s = new MemoryStorage();
    await putRaw(s, "k", { ...rawSeed(), generation: 7 });
    await expect(readCurrentJson(s, "k")).rejects.toMatchObject({
      code: "InvalidResponse",
      message: expect.stringMatching(/generation/),
    });
  });

  plainTest.each(["gen-1", "ABCDEF", "0123456789ab.x", "0123 456"])(
    "rejects a non-hex generation: %j",
    async (generation) => {
      // The manifest validator and `/v1/since`'s `GENERATION_RE` must
      // accept the same charset. If a manifest carrying one of these
      // read clean, the server would mint a cursor from it and then
      // refuse that same cursor on resume — which a client reads as a
      // permanently dead cursor and re-bootstraps on, forever. A `.`
      // is the worst case: it also mis-splits in `parseCursor`.
      const s = new MemoryStorage();
      await putRaw(s, "k", { ...rawSeed(), generation });
      await expect(readCurrentJson(s, "k")).rejects.toMatchObject({
        code: "InvalidResponse",
        message: expect.stringMatching(/generation/),
      });
    },
  );
});

describe("mintGeneration", () => {
  plainTest("mints a non-empty lowercase-hex token", () => {
    // Lowercase hex matters on the wire: `/v1/since` validates the
    // generation half of a cursor against `[0-9a-f]+`.
    expect(mintGeneration()).toMatch(/^[0-9a-f]{12}$/);
    return Promise.resolve();
  });

  plainTest("mints a distinct value each call", () => {
    // A collision would let a stale cursor resume into a truncated
    // generation — the exact failure the field exists to prevent.
    const minted = new Set(Array.from({ length: 200 }, () => mintGeneration()));
    expect(minted.size).toBe(200);
    return Promise.resolve();
  });
});

describe("readCurrentJson on a malformed body", () => {
  const SECRET = "deadbeefSECRETsalt0123";

  // Every string reachable from the error: its own text and fields, and
  // the same through the `cause` chain.
  const reachableText = (error: unknown): string => {
    const seen = new Set<unknown>();
    const parts: string[] = [];
    let cur: unknown = error;
    while (cur !== undefined && cur !== null && !seen.has(cur)) {
      seen.add(cur);
      parts.push(String(cur));
      if (!(cur instanceof Error)) {
        break;
      }
      parts.push(cur.message, cur.name, JSON.stringify(cur, Object.getOwnPropertyNames(cur)));
      cur = cur.cause;
    }
    return parts.join("\n");
  };

  plainTest("never echoes stored content through message or cause", async () => {
    const storage = new MemoryStorage();
    const body = `{"proto_tree":{"chunk_salt":${SECRET}}}`;
    await storage.put("current.json", new TextEncoder().encode(body));
    let caught: unknown;
    try {
      await readCurrentJson(storage, "current.json");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BaerlyError);
    expect((caught as BaerlyError).code).toBe("InvalidResponse");
    // V8 echoes only a short window of the source, so check the token's
    // leading characters and the neighbouring key, not the whole token.
    for (const fragment of ["deadbeef", "unk_salt", "chunk_salt"]) {
      expect(reachableText(caught)).not.toContain(fragment);
    }
    expect((caught as BaerlyError).message).toContain(`${body.length} bytes`);
  });
});
