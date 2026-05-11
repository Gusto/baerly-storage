import { fc, test as fcTest } from "@fast-check/vitest";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { MPS3Error } from "../errors";
import type { Storage, StorageListEntry } from "./types";

/**
 * Capability flags + arbitrary overrides for the conformance suite.
 * Defaults match the in-tree {@link MemoryStorage} / `LocalFsStorage`
 * impls; cloud adapters opt out of features they don't support.
 */
export interface ConformanceOptions {
  /** When false, the AbortSignal block is skipped wholesale. */
  readonly supportsAbort?: boolean;
  /** When false, both CAS blocks (`ifMatch`, `ifNoneMatch:"*"`) are skipped. */
  readonly supportsCAS?: boolean;
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
  /** Pinned size-boundary cap. Default: 1 MiB. */
  readonly maxBodyBytes?: number;
}

export interface ConformanceFactoryResult {
  readonly storage: Storage;
  readonly teardown?: () => Promise<void>;
}

export type ConformanceFactory = () => Promise<ConformanceFactoryResult>;

const KEY_CHARS =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.";

const DEFAULT_KEY_ARB = fc.string({
  minLength: 1,
  maxLength: 32,
  unit: fc.constantFrom(...KEY_CHARS.split("")),
});

const DEFAULT_BODY_ARB = fc.uint8Array({ minLength: 0, maxLength: 4096 });

const collect = async <T>(iter: AsyncIterable<T>): Promise<T[]> => {
  const out: T[] = [];
  for await (const x of iter) out.push(x);
  return out;
};

/**
 * Reset the storage between fast-check iterations by listing every key
 * and deleting it. Cheaper than constructing a fresh adapter per
 * sample (some adapters touch disk / network on construction); the
 * conformance suite already wires a per-test `factory()` for hard
 * isolation between vitest cases.
 */
const drain = async (s: Storage): Promise<void> => {
  const keys = (await collect(s.list(""))).map((e) => e.key);
  for (const k of keys) await s.delete(k);
};

const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
};

const PNG_FIXTURE = new Uint8Array([
  // 8-byte PNG signature + tiny IHDR chunk. Enough bytes to catch a
  // truncation / re-encoding bug without bringing a real image into
  // the test fixtures.
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06,
  0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
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
    supportsCAS: options.supportsCAS ?? true,
    caseSensitiveKeys: options.caseSensitiveKeys ?? true,
    keyArb: options.keyArb ?? DEFAULT_KEY_ARB,
    bodyArb: options.bodyArb ?? DEFAULT_BODY_ARB,
    maxBodyBytes: options.maxBodyBytes ?? 1 << 20,
  };

  describe(`Storage conformance — ${name}`, () => {
    let s: Storage;
    let teardown: (() => Promise<void>) | undefined;

    beforeEach(async () => {
      const r = await factory();
      s = r.storage;
      teardown = r.teardown;
    });
    afterEach(async () => {
      if (teardown) await teardown();
      teardown = undefined;
    });

    describe("get/put round-trip", () => {
      fcTest.prop({ k: opts.keyArb, body: opts.bodyArb })(
        "get(put(k, body)).body === body and etag matches",
        async ({ k, body }) => {
          await drain(s);
          const put = await s.put(k, body);
          const got = await s.get(k);
          expect(got).not.toBeNull();
          expect(bytesEqual(got!.body, body)).toBe(true);
          expect(got!.etag).toBe(put.etag);
        },
      );

      test("get of missing key returns null", async () => {
        expect(await s.get("missing")).toBeNull();
      });

      // Pinned size boundaries. 1 MiB is the upper bound declared via
      // `maxBodyBytes`; adapters with tighter limits should pass a
      // smaller value through `ConformanceOptions`.
      for (const size of [0, 1, 1024, 1 << 20]) {
        test(`round-trip exactly ${size} bytes`, async () => {
          if (size > opts.maxBodyBytes) return;
          const body = new Uint8Array(size);
          for (let i = 0; i < size; i += 1) body[i] = i & 0xff;
          const { etag } = await s.put("size", body);
          const got = await s.get("size");
          expect(got).not.toBeNull();
          expect(got!.body.length).toBe(size);
          expect(bytesEqual(got!.body, body)).toBe(true);
          expect(got!.etag).toBe(etag);
        });
      }
    });

    describe.skipIf(!opts.supportsCAS)("CAS — ifMatch", () => {
      test("succeeds and rotates etag on current etag", async () => {
        const first = await s.put("k", new TextEncoder().encode("v1"));
        const second = await s.put("k", new TextEncoder().encode("v2"), {
          ifMatch: first.etag,
        });
        expect(second.etag).not.toBe(first.etag);
        const got = await s.get("k");
        expect(got).not.toBeNull();
        expect(got!.etag).toBe(second.etag);
      });

      test("fails with MPS3Error InvalidResponse when key is absent", async () => {
        await expect(
          s.put("k", new TextEncoder().encode("v"), { ifMatch: '"deadbeef"' }),
        ).rejects.toBeInstanceOf(MPS3Error);
        await expect(
          s.put("k", new TextEncoder().encode("v"), { ifMatch: '"deadbeef"' }),
        ).rejects.toMatchObject({ code: "InvalidResponse" });
      });

      test("fails with MPS3Error InvalidResponse on stale etag", async () => {
        await s.put("k", new TextEncoder().encode("v1"));
        await expect(
          s.put("k", new TextEncoder().encode("v2"), { ifMatch: '"deadbeef"' }),
        ).rejects.toMatchObject({ code: "InvalidResponse" });
      });
    });

    describe.skipIf(!opts.supportsCAS)('CAS — ifNoneMatch="*"', () => {
      test("succeeds when key is absent", async () => {
        const { etag } = await s.put("k", new TextEncoder().encode("v"), {
          ifNoneMatch: "*",
        });
        expect(etag).toBeTruthy();
      });

      test("fails with MPS3Error InvalidResponse when key exists", async () => {
        await s.put("k", new TextEncoder().encode("v"));
        await expect(
          s.put("k", new TextEncoder().encode("v2"), { ifNoneMatch: "*" }),
        ).rejects.toBeInstanceOf(MPS3Error);
        await expect(
          s.put("k", new TextEncoder().encode("v3"), { ifNoneMatch: "*" }),
        ).rejects.toMatchObject({ code: "InvalidResponse" });
      });

      test("body is not modified on conflict", async () => {
        const original = new TextEncoder().encode("original");
        await s.put("k", original);
        await expect(
          s.put("k", new TextEncoder().encode("overwrite"), { ifNoneMatch: "*" }),
        ).rejects.toBeInstanceOf(MPS3Error);
        const got = await s.get("k");
        expect(got).not.toBeNull();
        expect(bytesEqual(got!.body, original)).toBe(true);
      });
    });

    describe("conditional get — ifNoneMatch", () => {
      test("returns null when current etag matches ifNoneMatch", async () => {
        const { etag } = await s.put("k", new TextEncoder().encode("v"));
        expect(await s.get("k", { ifNoneMatch: etag })).toBeNull();
      });

      test("returns the object when ifNoneMatch is stale", async () => {
        const { etag } = await s.put("k", new TextEncoder().encode("v"));
        const got = await s.get("k", { ifNoneMatch: '"deadbeef"' });
        expect(got).not.toBeNull();
        expect(got!.etag).toBe(etag);
      });
    });

    describe("delete", () => {
      test("removes a present key", async () => {
        await s.put("k", new TextEncoder().encode("v"));
        await s.delete("k");
        expect(await s.get("k")).toBeNull();
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
        const all = (await collect(s.list("a/"))).map((e) => e.key);
        expect(all).toEqual(["a/1", "a/2", "a/3"]);
      });

      test("startAfter is exclusive", async () => {
        await s.put("a/1", new TextEncoder().encode("a1"));
        await s.put("a/2", new TextEncoder().encode("a2"));
        await s.put("a/3", new TextEncoder().encode("a3"));
        const after = (await collect(s.list("a/", { startAfter: "a/1" }))).map(
          (e) => e.key,
        );
        expect(after).toEqual(["a/2", "a/3"]);
      });

      test("maxKeys caps the result", async () => {
        await s.put("a/1", new TextEncoder().encode("a1"));
        await s.put("a/2", new TextEncoder().encode("a2"));
        await s.put("a/3", new TextEncoder().encode("a3"));
        const capped = (await collect(s.list("a/", { maxKeys: 2 }))).map(
          (e) => e.key,
        );
        expect(capped).toEqual(["a/1", "a/2"]);
      });

      test("returns the current etag for each entry", async () => {
        const a = await s.put("a", new TextEncoder().encode("alpha"));
        const b = await s.put("b", new TextEncoder().encode("beta"));
        const entries = await collect(s.list(""));
        expect(entries).toEqual<StorageListEntry[]>([
          { key: "a", etag: a.etag },
          { key: "b", etag: b.etag },
        ]);
      });

      // Property: list(prefix) returns lex-sorted keys-with-prefix.
      // `keyArb` is constrained to non-slash characters, so prefixes
      // are simply a leading substring. Uniqueness is enforced by
      // `fc.uniqueArray`; gated on `caseSensitiveKeys` because some
      // stores collapse keys that differ only in case.
      fcTest.prop({
        entries: fc.uniqueArray(
          fc.tuple(opts.keyArb, opts.bodyArb),
          {
            minLength: 0,
            maxLength: 16,
            selector: ([k]) =>
              opts.caseSensitiveKeys ? k : k.toLowerCase(),
          },
        ),
        prefixChar: fc.constantFrom(...KEY_CHARS.split("")),
      })(
        "list(prefix) returns sorted keys-with-prefix",
        async ({ entries, prefixChar }) => {
          await drain(s);
          for (const [k, body] of entries) await s.put(k, body);
          const listed = (await collect(s.list(prefixChar))).map((e) => e.key);
          const expected = entries
            .map(([k]) => k)
            .filter((k) => k.startsWith(prefixChar))
            .toSorted();
          expect(listed).toEqual(expected);
        },
      );

      fcTest.prop({
        entries: fc.uniqueArray(
          fc.tuple(opts.keyArb, opts.bodyArb),
          {
            minLength: 1,
            maxLength: 16,
            selector: ([k]) =>
              opts.caseSensitiveKeys ? k : k.toLowerCase(),
          },
        ),
      })(
        "startAfter:k yields strict suffix of lex-sorted keys",
        async ({ entries }) => {
          await drain(s);
          for (const [k, body] of entries) await s.put(k, body);
          const sorted = entries.map(([k]) => k).toSorted();
          // Use the first key as the cursor — should yield everything
          // strictly greater than it.
          const cursor = sorted[0]!;
          const listed = (
            await collect(s.list("", { startAfter: cursor }))
          ).map((e) => e.key);
          expect(listed).toEqual(sorted.filter((k) => k > cursor));
        },
      );
    });

    describe("binary fidelity", () => {
      test("PNG byte sequence round-trips byte-for-byte", async () => {
        await s.put("img", PNG_FIXTURE);
        const got = await s.get("img");
        expect(got).not.toBeNull();
        expect(bytesEqual(got!.body, PNG_FIXTURE)).toBe(true);
      });

      test("UTF-8 multi-byte text round-trips", async () => {
        const original = "héllo🌍";
        const bytes = new TextEncoder().encode(original);
        await s.put("utf8", bytes);
        const got = await s.get("utf8");
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
        await expect(
          s.delete("k", { signal: ac.signal }),
        ).rejects.toBeDefined();
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
