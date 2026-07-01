import { fc, test as fcTest } from "@fast-check/vitest";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { BaerlyError, type BaerlyErrorCode } from "../errors.ts";
import type { Storage } from "./types.ts";

/**
 * Capability flags + arbitrary overrides for the conformance suite.
 * Defaults match the in-tree {@link MemoryStorage} / `LocalFsStorage`
 * impls; cloud adapters opt out of features they don't support.
 */
export interface ConformanceOptions {
  /** When false, the AbortSignal block is skipped wholesale. */
  readonly supportsAbort?: boolean;
  // NOTE: there is no `supportsCAS` opt-out. The conditional writes
  // (`ifMatch` / `ifNoneMatch:"*"`) are a HARD protocol prerequisite —
  // the log-append commit relies on `ifNoneMatch:"*"` create-if-absent
  // being exactly-one-winner under concurrency (the winning create IS
  // the commit), and the compactor CAS-advances `current.json` with
  // `ifMatch` under the no-lease maintenance fold — so a `Storage` that
  // doesn't honor them isn't a valid baerly backend. The CAS blocks
  // below always run; a backend that can't pass them must not ship.
  // CAVEAT: these blocks exercise single-process semantics. `LocalFsStorage`
  // is a dev/single-process adapter whose `ifMatch` is in-process TOCTOU
  // only (cross-process `current.json` CAS-advance is NOT atomic there) —
  // see its class JSDoc in `packages/dev/src/local-fs.ts`. Real S3 / Minio
  // / R2 provide the cross-process guarantee the no-lease fold relies on.
  /**
   * When false, generated key arbitraries must yield case-insensitively
   * distinct keys (some object stores fold case). Defaults to `true`;
   * both in-tree impls preserve case verbatim.
   */
  readonly caseSensitiveKeys?: boolean;
  /** Override the default key arbitrary. Default: printable-ASCII non-slash, len 1..32. */
  readonly keyArb?: fc.Arbitrary<string>;
  /** Override the default body arbitrary. Default: Uint8Array, len 0..4096. */
  readonly bodyArb?: fc.Arbitrary<Uint8Array>;
  /**
   * Override the arbitrary used as the single-character `prefix`
   * passed to `list(prefix)`. Default: any char from the canonical
   * `KEY_CHARS` set (a `list` prefix rides in the `?prefix=` query
   * component, so `.`/`..` are harmless there — unlike a *key*, which
   * is a path segment; see {@link keyArb} and the "key namespace"
   * block). Rarely needs overriding.
   */
  readonly prefixCharArb?: fc.Arbitrary<string>;
  /** Pinned size-boundary cap. Default: 1 MiB. */
  readonly maxBodyBytes?: number;
  /**
   * When true, the backend's `list` is eventually consistent —
   * list-after-write and list-after-delete may lag, as real Cloudflare
   * R2's S3 `ListObjectsV2` does (object read-after-write and the
   * conditional-write verbs stay strong; only the bucket index lags).
   * List/read-back assertions and the per-test `drain()` reset then poll
   * until the store converges instead of asserting a single immediate
   * snapshot. Defaults to false — Memory/LocalFs/Minio/native-R2-binding
   * are strongly consistent for list and assert the first read.
   *
   * This flag is about *consistency* only. The *network-latency*
   * accommodations (reduced property `numRuns`, raised per-test timeout)
   * live on {@link remoteNetwork}, which this flag implies — an
   * eventually-consistent backend is necessarily remote.
   */
  readonly eventuallyConsistentList?: boolean;
  /**
   * When true, the backend is a real remote HTTP endpoint (AWS S3, GCS,
   * Cloudflare R2 over the S3 API) where every op is a network
   * round-trip. Independent of the consistency model: AWS S3 is strongly
   * consistent yet still remote. Property-test `numRuns` is reduced (the
   * default 100 is hundreds of round-trips per property — infeasible in
   * the test budget, and a resulting timeout orphan-bleeds writes into
   * later tests via the shared handle, see `tests/setup/fast-check.ts`)
   * and the per-test timeout is raised to absorb network latency.
   * {@link eventuallyConsistentList} implies this. Defaults to false —
   * Memory/LocalFs/native-R2-binding and the local Minio dev stack run
   * the full local fuzz budget under the default timeout.
   */
  readonly remoteNetwork?: boolean;
}

export interface ConformanceFactoryResult {
  readonly storage: Storage;
  readonly teardown?: () => Promise<void>;
}

export type ConformanceFactory = () => Promise<ConformanceFactoryResult>;

const KEY_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.";

// The generated key space is the portable baerly key grammar: a bare `.`
// or `..` is excluded because it is *not a valid key on any HTTP-S3
// backend* — RFC 3986 dot-segment removal (universal across every
// language's URL parser) rewrites `<bucket>/.` → `<bucket>/` before the
// request is sent, so it can never be addressed. The adapters reject it
// with `InvalidConfig`; the "key namespace" block below asserts that.
// @see docs/spec/storage-compatibility.md "Key namespace".
const DEFAULT_KEY_ARB = fc
  .string({
    minLength: 1,
    maxLength: 32,
    unit: fc.constantFrom(...KEY_CHARS.split("")),
  })
  .filter((k) => k !== "." && k !== "..");

const DEFAULT_BODY_ARB = fc.uint8Array({ minLength: 0, maxLength: 4096 });

/**
 * Convergence budget for a backend whose `list` is eventually consistent
 * (`eventuallyConsistentList`). List/read-back assertions and the per-test
 * `drain()` reset poll up to this long for the store to settle before
 * asserting. Strongly-consistent backends use `settle === 0` and assert
 * the first read, so this is never paid by Memory/LocalFs/Minio/R2-binding.
 */
const EVENTUAL_CONSISTENCY_SETTLE_MILLIS = 15_000;
/** Poll interval while waiting for an eventually-consistent backend to settle. */
const EVENTUAL_CONSISTENCY_POLL_MILLIS = 250;
/**
 * Per-test/hook timeout raised for a remote-network backend: each op is a
 * real network round-trip (and, on an eventually-consistent backend,
 * assertions poll), so the 5s default is too tight. Applied as the
 * suite-level `timeout` (cascades to every inner test) and as the explicit
 * `beforeEach` hook timeout.
 */
const REMOTE_NETWORK_TEST_TIMEOUT_MILLIS = 120_000;
/**
 * fast-check `numRuns` for property tests on a remote-network backend. The
 * default 100 is hundreds of network round-trips per property — infeasible
 * in the test budget, and a resulting timeout orphan-bleeds writes into
 * later tests via the shared handle (see `tests/setup/fast-check.ts`). The
 * heavy fuzzing runs on the in-memory / local-fs adapters; this only
 * smoke-checks the property over the wire.
 */
const REMOTE_NETWORK_PROPERTY_RUNS = 10;
/**
 * fast-check `numRuns` for property tests on an eventually-consistent
 * backend — fewer than {@link REMOTE_NETWORK_PROPERTY_RUNS}. Each iteration
 * pays *two* convergence polls (the `drain()` reset and the settle-assert,
 * up to {@link EVENTUAL_CONSISTENCY_SETTLE_MILLIS} each), so an
 * eventually-consistent iteration costs ~2× a strongly-consistent remote
 * one. At 10 runs a slow-convergence window can spill past the raised
 * per-test timeout; halving the runs keeps the property comfortably inside
 * it while still smoke-checking it over the wire.
 */
const EVENTUAL_CONSISTENCY_PROPERTY_RUNS = 5;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Read until `ok(value)` holds or the convergence deadline elapses, then
 * return the last value read. With `settle === 0` (strongly-consistent
 * backend) this is a single immediate read — behaviourally identical to a
 * bare `await read()`. On non-convergence it returns the last value so the
 * caller's assertion produces a meaningful diff rather than a timeout.
 */
async function pollUntil<T>(
  read: () => Promise<T>,
  ok: (value: T) => boolean,
  settle: number,
): Promise<T> {
  let value = await read();
  if (settle === 0 || ok(value)) {
    return value;
  }
  const deadline = Date.now() + settle;
  while (Date.now() < deadline) {
    await sleep(EVENTUAL_CONSISTENCY_POLL_MILLIS);
    value = await read();
    if (ok(value)) {
      return value;
    }
  }
  return value;
}

const jsonEq = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Poll `read` until it deep-equals `expected` (or the deadline), then assert. */
async function expectEventuallyEqual<T>(
  read: () => Promise<T>,
  expected: T,
  settle: number,
): Promise<void> {
  const actual = await pollUntil(read, (v) => jsonEq(v, expected), settle);
  expect(actual).toEqual(expected);
}

const collect = async <T>(iter: AsyncIterable<T>): Promise<T[]> => {
  const out: T[] = [];
  for await (const x of iter) {
    out.push(x);
  }
  return out;
};

/**
 * Reset the storage between fast-check iterations by listing every key
 * and deleting it. Cheaper than constructing a fresh adapter per
 * sample (some adapters touch disk / network on construction); the
 * conformance suite already wires a per-test `factory()` for hard
 * isolation between vitest cases.
 */
const drain = async (s: Storage, settle = 0): Promise<void> => {
  const deleteAllOnce = async (): Promise<number> => {
    const listed = await collect(s.list(""));
    const keys = listed.map((e) => e.key);
    for (const k of keys) {
      await s.delete(k);
    }
    return keys.length;
  };
  if (settle === 0) {
    await deleteAllOnce();
    return;
  }
  // Eventually-consistent backend: a just-written (or just-deleted) key
  // may not yet be reflected in `list`, so a single sweep can leave
  // residue that bleeds into the next test. Sweep until two consecutive
  // lists come back empty, or the convergence deadline elapses.
  const deadline = Date.now() + settle;
  let consecutiveEmpty = 0;
  while (Date.now() < deadline && consecutiveEmpty < 2) {
    const removed = await deleteAllOnce();
    if (removed === 0) {
      consecutiveEmpty += 1;
      await sleep(EVENTUAL_CONSISTENCY_POLL_MILLIS);
    } else {
      consecutiveEmpty = 0;
    }
  }
};

const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
};

const PNG_FIXTURE = new Uint8Array([
  // 8-byte PNG signature + tiny IHDR chunk. Enough bytes to catch a
  // truncation / re-encoding bug without bringing a real image into
  // the test fixtures.
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89,
]);

/**
 * Define a `Storage` conformance suite. Call once per adapter from the
 * adapter's `*.test.ts`; the suite owns `describe`/`beforeEach`/
 * `afterEach` and asserts the contract documented on the `Storage`
 * interface. Capability flags gate blocks via `describe.skipIf` rather
 * than per-test `if` guards, so vitest reports skipped blocks honestly.
 *
 * The factory is invoked per test (in `beforeEach`); adapters that
 * need teardown (e.g. `LocalFsStorage` mktemp dirs) return a
 * `teardown` callback.
 */
export function defineStorageConformanceSuite(
  name: string,
  factory: ConformanceFactory,
  options: ConformanceOptions = {},
): void {
  const opts: Required<ConformanceOptions> = {
    supportsAbort: options.supportsAbort ?? true,
    caseSensitiveKeys: options.caseSensitiveKeys ?? true,
    keyArb: options.keyArb ?? DEFAULT_KEY_ARB,
    bodyArb: options.bodyArb ?? DEFAULT_BODY_ARB,
    prefixCharArb: options.prefixCharArb ?? fc.constantFrom(...KEY_CHARS.split("")),
    maxBodyBytes: options.maxBodyBytes ?? 1 << 20,
    eventuallyConsistentList: options.eventuallyConsistentList ?? false,
    remoteNetwork: options.remoteNetwork ?? false,
  };

  // An eventually-consistent backend is necessarily remote, so it inherits
  // the network-latency accommodations below even if the caller only set
  // the consistency flag.
  const isRemote = opts.remoteNetwork || opts.eventuallyConsistentList;
  // Convergence budget (0 = strongly-consistent, assert the first read).
  // Gated on the *consistency* flag only — a strongly-consistent remote
  // backend (AWS S3) still asserts the first read.
  const settle = opts.eventuallyConsistentList ? EVENTUAL_CONSISTENCY_SETTLE_MILLIS : 0;
  // Reduced property-test fuzzing for a remote-network backend; `undefined`
  // leaves the global `numRuns` (see fast-check.ts). An eventually-
  // consistent backend polls twice per iteration (drain + settle-assert),
  // so it runs fewer iterations still.
  const propRuns = opts.eventuallyConsistentList
    ? EVENTUAL_CONSISTENCY_PROPERTY_RUNS
    : REMOTE_NETWORK_PROPERTY_RUNS;
  const propParams = isRemote ? { numRuns: propRuns } : undefined;
  // A remote backend does real network round-trips (and, when eventually
  // consistent, polls), so the default 5s per-test/hook timeout is too
  // tight. `undefined` leaves the runner default for local backends. The
  // suite-level option cascades to every inner test (including the
  // fast-check property tests); the per-hook timeout below covers the
  // `drain()` in `beforeEach`. (`vi.setConfig` in a hook is too late —
  // vitest binds timeouts at collection time.)
  const testTimeoutMs = isRemote ? REMOTE_NETWORK_TEST_TIMEOUT_MILLIS : undefined;

  describe(`Storage conformance — ${name}`, { timeout: testTimeoutMs }, () => {
    let s: Storage;
    let teardown: (() => Promise<void>) | undefined;

    beforeEach(async () => {
      const r = await factory();
      s = r.storage;
      teardown = r.teardown;
      // Shared-backend adapters (real S3 / R2 against a persistent
      // bucket) cannot rely on `factory()` for isolation — every test
      // sees the residue of every prior test. Drain on entry so each
      // case starts from an empty namespace. No-op for fresh in-memory
      // / temp-dir factories.
      await drain(s, settle);
    }, testTimeoutMs);
    afterEach(async () => {
      if (teardown) {
        await teardown();
      }
      teardown = undefined;
    });

    describe("get/put round-trip", () => {
      fcTest.prop({ k: opts.keyArb, body: opts.bodyArb }, propParams)(
        "get(put(k, body)).body === body and etag matches",
        async ({ k, body }) => {
          await drain(s, settle);
          const put = await s.put(k, body);
          const got = await pollUntil(
            () => s.get(k),
            (g) => g !== null && g.etag === put.etag && bytesEqual(g.body, body),
            settle,
          );
          expect(got).not.toBeNull();
          expect(bytesEqual(got!.body, body)).toBe(true);
          expect(got!.etag).toBe(put.etag);
        },
      );

      test("get of missing key returns null", async () => {
        await expect(s.get("missing")).resolves.toBeNull();
      });

      // Pinned size boundaries. 1 MiB is the upper bound declared via
      // `maxBodyBytes`; adapters with tighter limits should pass a
      // smaller value through `ConformanceOptions`.
      for (const size of [0, 1, 1024, 1 << 20]) {
        test(`round-trip exactly ${size} bytes`, async () => {
          if (size > opts.maxBodyBytes) {
            return;
          }
          const body = new Uint8Array(size);
          for (let i = 0; i < size; i += 1) {
            body[i] = i & 0xff;
          }
          const { etag } = await s.put("size", body);
          const got = await pollUntil(
            () => s.get("size"),
            (g) => g !== null && g.etag === etag && g.body.length === size,
            settle,
          );
          expect(got).not.toBeNull();
          expect(got!.body.length).toBe(size);
          expect(bytesEqual(got!.body, body)).toBe(true);
          expect(got!.etag).toBe(etag);
        });
      }
    });

    describe("key namespace", () => {
      // A bare "." or ".." is not a valid key on ANY backend and every
      // adapter must reject it *identically* with `InvalidConfig`. On the
      // HTTP-S3 adapters it is physically unaddressable — RFC 3986
      // dot-segment removal (universal across every language's URL parser)
      // rewrites `<bucket>/.` → `<bucket>/` before the request is signed,
      // so a naïve PUT hits the bucket root and 403s. The binding / memory
      // / local-fs adapters could technically store it, but reject it too
      // so the portable contract is one rule, not per-backend. This is the
      // cross-adapter equivalent of `assertPathSegment` one layer up.
      // @see docs/spec/storage-compatibility.md "Key namespace".
      const enc = new TextEncoder();
      for (const badKey of [".", ".."]) {
        const label = JSON.stringify(badKey);
        test(`put(${label}) rejects with InvalidConfig`, async () => {
          const p = s.put(badKey, enc.encode("v"));
          await expect(p).rejects.toBeInstanceOf(BaerlyError);
          await expect(p).rejects.toMatchObject({ code: "InvalidConfig" });
        });
        test(`get(${label}) rejects with InvalidConfig`, async () => {
          await expect(s.get(badKey)).rejects.toMatchObject({ code: "InvalidConfig" });
        });
        test(`delete(${label}) rejects with InvalidConfig`, async () => {
          await expect(s.delete(badKey)).rejects.toMatchObject({ code: "InvalidConfig" });
        });
      }
    });

    describe("CAS — ifMatch", () => {
      test("succeeds and rotates etag on current etag", async () => {
        const first = await s.put("k", new TextEncoder().encode("v1"));
        // On an eventually-consistent backend the `ifMatch` overwrite can
        // hit a replica that hasn't seen `first` yet and spuriously 412 —
        // wait until the first write is observable before the CAS.
        await pollUntil(
          () => s.get("k"),
          (g) => g !== null && g.etag === first.etag,
          settle,
        );
        const second = await s.put("k", new TextEncoder().encode("v2"), {
          ifMatch: first.etag,
        });
        expect(second.etag).not.toBe(first.etag);
        const got = await pollUntil(
          () => s.get("k"),
          (g) => g !== null && g.etag === second.etag,
          settle,
        );
        expect(got).not.toBeNull();
        expect(got!.etag).toBe(second.etag);
      });

      test("fails with BaerlyError Conflict when key is absent", async () => {
        await expect(
          s.put("k", new TextEncoder().encode("v"), { ifMatch: '"deadbeef"' }),
        ).rejects.toBeInstanceOf(BaerlyError);
        await expect(
          s.put("k", new TextEncoder().encode("v"), { ifMatch: '"deadbeef"' }),
        ).rejects.toMatchObject({ code: "Conflict" });
      });

      test("fails with BaerlyError Conflict on stale etag", async () => {
        await s.put("k", new TextEncoder().encode("v1"));
        await expect(
          s.put("k", new TextEncoder().encode("v2"), { ifMatch: '"deadbeef"' }),
        ).rejects.toMatchObject({ code: "Conflict" });
      });
    });

    describe('CAS — ifNoneMatch="*"', () => {
      test("succeeds when key is absent", async () => {
        const { etag } = await s.put("k", new TextEncoder().encode("v"), {
          ifNoneMatch: "*",
        });
        expect(etag).toBeTruthy();
      });

      test("fails with BaerlyError Conflict when key exists", async () => {
        await s.put("k", new TextEncoder().encode("v"));
        await expect(
          s.put("k", new TextEncoder().encode("v2"), { ifNoneMatch: "*" }),
        ).rejects.toBeInstanceOf(BaerlyError);
        await expect(
          s.put("k", new TextEncoder().encode("v3"), { ifNoneMatch: "*" }),
        ).rejects.toMatchObject({ code: "Conflict" });
      });

      test("body is not modified on conflict", async () => {
        const original = new TextEncoder().encode("original");
        await s.put("k", original);
        await expect(
          s.put("k", new TextEncoder().encode("overwrite"), { ifNoneMatch: "*" }),
        ).rejects.toBeInstanceOf(BaerlyError);
        const got = await pollUntil(
          () => s.get("k"),
          (g) => g !== null && bytesEqual(g.body, original),
          settle,
        );
        expect(got).not.toBeNull();
        expect(bytesEqual(got!.body, original)).toBe(true);
      });

      test("admits exactly one winner under concurrent create-if-absent", async () => {
        const RACERS = 16;
        const enc = new TextEncoder();
        const outcomes = await Promise.allSettled(
          Array.from({ length: RACERS }, (_u, i) =>
            s.put("k", enc.encode(`r${i}`), { ifNoneMatch: "*" }),
          ),
        );
        const winners = outcomes.filter((o) => o.status === "fulfilled").length;
        // A contended loser may legitimately surface as either `Conflict`
        // (412 — Memory/LocalFs/Minio/R2) or a retryable `NetworkError`
        // (409 ConditionalRequestConflict — real AWS S3). Both are valid
        // loser outcomes at the raw-`Storage.put` layer (no writer retry);
        // the load-bearing property is exactly-one-winner.
        const losers = outcomes.filter(
          (o) =>
            o.status === "rejected" &&
            o.reason instanceof BaerlyError &&
            (o.reason.code === "Conflict" || o.reason.code === "NetworkError"),
        ).length;
        expect(winners).toBe(1);
        expect(losers).toBe(RACERS - 1);
      });
    });

    // Error-code parity — the canonical "every adapter throws the same
    // BaerlyError.code for the same illegal op" statement. The suite runs
    // against all four adapters, so this single table is the cross-adapter
    // equivalence assertion. `expectedCodes` is a SET, never a single code:
    // a contended create-loser legitimately diverges between `Conflict`
    // (412 — Memory/LocalFs/Minio/R2) and a retryable `NetworkError`
    // (409 ConditionalRequestConflict — real AWS S3); see the
    // exactly-one-winner test above. Asserting a single code would
    // manufacture false parity.
    const ENC = new TextEncoder();
    const ERROR_PARITY_TABLE: ReadonlyArray<{
      readonly label: string;
      readonly act: (store: Storage) => Promise<unknown>;
      readonly expectedCodes: ReadonlyArray<BaerlyErrorCode>;
    }> = [
      {
        label: "stale ifMatch",
        act: async (store) => {
          await store.put("k", ENC.encode("v1"));
          return store.put("k", ENC.encode("v2"), { ifMatch: '"deadbeef"' });
        },
        expectedCodes: ["Conflict"],
      },
      {
        label: 'ifNoneMatch:"*" on existing key',
        act: async (store) => {
          await store.put("k", ENC.encode("v"));
          return store.put("k", ENC.encode("v2"), { ifNoneMatch: "*" });
        },
        expectedCodes: ["Conflict"],
      },
      {
        label: "concurrent create-if-absent loser",
        act: async (store) => {
          const outcomes = await Promise.allSettled(
            Array.from({ length: 16 }, (_u, i) =>
              store.put("k", ENC.encode(`r${i}`), { ifNoneMatch: "*" }),
            ),
          );
          const loser = outcomes.find((o) => o.status === "rejected");
          if (loser === undefined) {
            throw new Error("expected at least one contended loser");
          }
          throw (loser as PromiseRejectedResult).reason;
        },
        expectedCodes: ["Conflict", "NetworkError"],
      },
    ];

    describe("error-code parity", () => {
      for (const row of ERROR_PARITY_TABLE) {
        test(`${row.label} → ${row.expectedCodes.join("|")}`, async () => {
          let err: unknown;
          try {
            await row.act(s);
          } catch (error) {
            err = error;
          }
          expect(err, `${row.label} must reject`).toBeInstanceOf(BaerlyError);
          expect(row.expectedCodes, `${row.label} → code ${(err as BaerlyError).code}`).toContain(
            (err as BaerlyError).code,
          );
        });
      }
    });

    describe("conditional get — ifNoneMatch", () => {
      test("returns null when current etag matches ifNoneMatch", async () => {
        const { etag } = await s.put("k", new TextEncoder().encode("v"));
        const got = await pollUntil(
          () => s.get("k", { ifNoneMatch: etag }),
          (g) => g === null,
          settle,
        );
        expect(got).toBeNull();
      });

      test("returns the object when ifNoneMatch is stale", async () => {
        const { etag } = await s.put("k", new TextEncoder().encode("v"));
        const got = await pollUntil(
          () => s.get("k", { ifNoneMatch: '"deadbeef"' }),
          (g) => g !== null && g.etag === etag,
          settle,
        );
        expect(got).not.toBeNull();
        expect(got!.etag).toBe(etag);
      });
    });

    describe("delete", () => {
      test("removes a present key", async () => {
        await s.put("k", new TextEncoder().encode("v"));
        await s.delete("k");
        const got = await pollUntil(
          () => s.get("k"),
          (g) => g === null,
          settle,
        );
        expect(got).toBeNull();
      });

      test("is idempotent on a missing key", async () => {
        await expect(s.delete("missing")).resolves.toBeUndefined();
      });
    });

    describe("list", () => {
      test("yields keys lex-asc and filtered by prefix", async () => {
        await s.put("b/2", new TextEncoder().encode("b2"));
        await s.put("a/1", new TextEncoder().encode("a1"));
        await s.put("a/3", new TextEncoder().encode("a3"));
        await s.put("a/2", new TextEncoder().encode("a2"));
        await s.put("c/0", new TextEncoder().encode("c0"));
        await expectEventuallyEqual(
          () => collect(s.list("a/")).then((l) => l.map((e) => e.key)),
          ["a/1", "a/2", "a/3"],
          settle,
        );
      });

      test("startAfter is exclusive", async () => {
        await s.put("a/1", new TextEncoder().encode("a1"));
        await s.put("a/2", new TextEncoder().encode("a2"));
        await s.put("a/3", new TextEncoder().encode("a3"));
        await expectEventuallyEqual(
          () => collect(s.list("a/", { startAfter: "a/1" })).then((l) => l.map((e) => e.key)),
          ["a/2", "a/3"],
          settle,
        );
      });

      test("maxKeys caps the result", async () => {
        await s.put("a/1", new TextEncoder().encode("a1"));
        await s.put("a/2", new TextEncoder().encode("a2"));
        await s.put("a/3", new TextEncoder().encode("a3"));
        await expectEventuallyEqual(
          () => collect(s.list("a/", { maxKeys: 2 })).then((l) => l.map((e) => e.key)),
          ["a/1", "a/2"],
          settle,
        );
      });

      test("returns the current etag for each entry", async () => {
        const a = await s.put("a", new TextEncoder().encode("alpha"));
        const b = await s.put("b", new TextEncoder().encode("beta"));
        // `StorageListEntry.lastModified` is optional per the type;
        // some adapters (R2 binding, S3) populate it from server-side
        // headers. Project to the load-bearing fields only.
        await expectEventuallyEqual(
          () =>
            collect(s.list("")).then((entries) => entries.map(({ key, etag }) => ({ key, etag }))),
          [
            { key: "a", etag: a.etag },
            { key: "b", etag: b.etag },
          ],
          settle,
        );
      });

      // Property: list(prefix) returns lex-sorted keys-with-prefix.
      // `keyArb` is constrained to non-slash characters, so prefixes
      // are simply a leading substring. Uniqueness is enforced by
      // `fc.uniqueArray`; gated on `caseSensitiveKeys` because some
      // stores collapse keys that differ only in case.
      fcTest.prop(
        {
          entries: fc.uniqueArray(fc.tuple(opts.keyArb, opts.bodyArb), {
            minLength: 0,
            maxLength: 16,
            selector: ([k]) => (opts.caseSensitiveKeys ? k : k.toLowerCase()),
          }),
          prefixChar: opts.prefixCharArb,
        },
        propParams,
      )("list(prefix) returns sorted keys-with-prefix", async ({ entries, prefixChar }) => {
        await drain(s, settle);
        for (const [k, body] of entries) {
          await s.put(k, body);
        }
        const expected = entries
          .map(([k]) => k)
          .filter((k) => k.startsWith(prefixChar))
          .toSorted();
        await expectEventuallyEqual(
          () => collect(s.list(prefixChar)).then((c) => c.map((e) => e.key)),
          expected,
          settle,
        );
      });

      fcTest.prop(
        {
          entries: fc.uniqueArray(fc.tuple(opts.keyArb, opts.bodyArb), {
            minLength: 1,
            maxLength: 16,
            selector: ([k]) => (opts.caseSensitiveKeys ? k : k.toLowerCase()),
          }),
        },
        propParams,
      )("startAfter:k yields strict suffix of lex-sorted keys", async ({ entries }) => {
        await drain(s, settle);
        for (const [k, body] of entries) {
          await s.put(k, body);
        }
        const sorted = entries.map(([k]) => k).toSorted();
        // Use the first key as the cursor — should yield everything
        // strictly greater than it.
        const cursor = sorted[0]!;
        const expected = sorted.filter((k) => k > cursor);
        await expectEventuallyEqual(
          () => collect(s.list("", { startAfter: cursor })).then((c) => c.map((e) => e.key)),
          expected,
          settle,
        );
      });
    });

    describe("binary fidelity", () => {
      test("PNG byte sequence round-trips byte-for-byte", async () => {
        await s.put("img", PNG_FIXTURE);
        const got = await pollUntil(
          () => s.get("img"),
          (g) => g !== null && bytesEqual(g.body, PNG_FIXTURE),
          settle,
        );
        expect(got).not.toBeNull();
        expect(bytesEqual(got!.body, PNG_FIXTURE)).toBe(true);
      });

      test("UTF-8 multi-byte text round-trips", async () => {
        const original = "héllo🌍";
        const bytes = new TextEncoder().encode(original);
        await s.put("utf8", bytes);
        const got = await pollUntil(
          () => s.get("utf8"),
          (g) => g !== null && new TextDecoder().decode(g.body) === original,
          settle,
        );
        expect(got).not.toBeNull();
        expect(new TextDecoder().decode(got!.body)).toBe(original);
      });
    });

    describe.skipIf(!opts.supportsAbort)("AbortSignal", () => {
      test("pre-aborted signal rejects get/put/delete", async () => {
        const ac = new AbortController();
        ac.abort();
        await expect(s.get("k", { signal: ac.signal })).rejects.toBeDefined();
        await expect(
          s.put("k", new TextEncoder().encode("v"), { signal: ac.signal }),
        ).rejects.toBeDefined();
        await expect(s.delete("k", { signal: ac.signal })).rejects.toBeDefined();
      });

      test("pre-aborted signal rejects list", async () => {
        const ac = new AbortController();
        ac.abort();
        // `list` is an async iterable; consuming it should throw.
        await expect(
          (async () => {
            for await (const _ of s.list("", { signal: ac.signal })) {
              // unreachable
            }
          })(),
        ).rejects.toBeDefined();
      });
    });
  });
}
