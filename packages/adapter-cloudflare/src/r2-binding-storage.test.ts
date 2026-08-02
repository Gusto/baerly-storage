/**
 * Unit pins for `r2BindingStorage.list`'s `maxKeys` handling.
 *
 * `docs/spec/storage-compatibility.md` list clause 6 makes two
 * requirements normative: `maxKeys` is a hard TOTAL across the port's
 * internal pagination (not a per-page limit), and a port MUST clamp it
 * to its wire maximum rather than forwarding it verbatim. The clause
 * also states that the cross-adapter conformance suite **cannot reach
 * either one** — its fixtures are a handful of keys and no in-tree
 * backend pages below 1000 — so each port must pin them itself.
 *
 * `s3-http.test.ts` does that for the S3 port. This file is the R2
 * half, which was missing: `r2-binding-storage.ts` implements both
 * correctly (`Math.min(cap - yielded, 1000)`), but nothing asserted it,
 * so a regression would have shipped green.
 *
 * Both are load-bearing for GC's rotation cursors, which infer
 * end-of-keyspace from "the LIST yielded FEWER than maxKeys". A port
 * that stopped at a short first page would report a false wrap on every
 * pass, clearing the cursor forever and reinstating exactly the stall
 * the cursor exists to remove.
 *
 * These are plain unit tests over a fake binding — no miniflare — so
 * they run in the DEFAULT vitest project on every `pnpm test`, not only
 * under `pnpm test:adapter-cloudflare`.
 */

import { describe, expect, test } from "vitest";
import { r2BindingStorage } from "./r2-binding-storage.ts";

interface FakePage {
  readonly keys: readonly string[];
  readonly truncated: boolean;
}

/**
 * A minimal `R2Bucket` whose `list` replays `pages` in order and
 * records the `R2ListOptions` it was handed, so a test can assert on
 * the `limit` that crossed the binding boundary.
 */
const mkBucket = (pages: readonly FakePage[]): { bucket: R2Bucket; calls: R2ListOptions[] } => {
  const calls: R2ListOptions[] = [];
  let i = 0;
  const bucket = {
    list: (opts: R2ListOptions) => {
      calls.push(opts);
      const page = pages[Math.min(i, pages.length - 1)]!;
      i += 1;
      return Promise.resolve({
        objects: page.keys.map((key) => ({ key, etag: "deadbeef" })),
        truncated: page.truncated,
        cursor: page.truncated ? `tok${i}` : undefined,
      });
    },
  } as unknown as R2Bucket;
  return { bucket, calls };
};

describe("r2BindingStorage.list maxKeys", () => {
  test("an effectively-unbounded maxKeys is clamped to the 1000-key wire maximum", async () => {
    // GC's unbounded reconcile path passes `Number.MAX_SAFE_INTEGER`.
    // R2 rejects anything over 1000 with `MaxKeys params must be
    // positive integer <= 1000. (10022)`, so forwarding it verbatim
    // would fail every unbounded LIST.
    const { bucket, calls } = mkBucket([{ keys: ["p/a"], truncated: false }]);
    const s = r2BindingStorage(bucket);
    const out: string[] = [];
    for await (const e of s.list("p/", { maxKeys: Number.MAX_SAFE_INTEGER })) {
      out.push(e.key);
    }
    expect(out).toEqual(["p/a"]);
    expect(calls[0]?.limit).toBe(1000);
  });

  test("maxKeys is a hard TOTAL across pages, not a per-page limit", async () => {
    // The binding pages at 2; we ask for 3. Stopping at the page
    // boundary would yield ["p/a","p/b"] and, to a rotation cursor,
    // look like the end of the keyspace.
    const { bucket, calls } = mkBucket([
      { keys: ["p/a", "p/b"], truncated: true },
      { keys: ["p/c", "p/d"], truncated: false },
    ]);
    const s = r2BindingStorage(bucket);
    const out: string[] = [];
    for await (const e of s.list("p/", { maxKeys: 3 })) {
      out.push(e.key);
    }
    expect(out).toEqual(["p/a", "p/b", "p/c"]);
    expect(calls).toHaveLength(2);
    // The remaining budget rides on the follow-up request, so the
    // second page asks for 1, not 3.
    expect(calls[1]?.limit).toBe(1);
    expect(calls[1]?.cursor).toBe("tok1");
  });

  test("startAfter rides the FIRST page only; later pages use the cursor", async () => {
    // R2's `startAfter` is a one-shot cursor. Sending it alongside a
    // continuation `cursor` on page 2 would re-anchor the scan.
    const { bucket, calls } = mkBucket([
      { keys: ["p/b"], truncated: true },
      { keys: ["p/c"], truncated: false },
    ]);
    const s = r2BindingStorage(bucket);
    const out: string[] = [];
    for await (const e of s.list("p/", { startAfter: "p/a", maxKeys: 2 })) {
      out.push(e.key);
    }
    expect(out).toEqual(["p/b", "p/c"]);
    expect(calls[0]?.startAfter).toBe("p/a");
    expect(calls[1]?.startAfter).toBeUndefined();
    expect(calls[1]?.cursor).toBe("tok1");
  });
});
