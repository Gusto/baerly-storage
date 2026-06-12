/**
 * Patent C3 evidence — descending-base-32 LSN tuple yields
 * reverse-causal ordering under forward-only `Storage.list`.
 *
 * INVARIANT (property statement):
 *   For any pair of LSNs A and B causally ordered A < B
 *   (i.e. A's (time, seq) tuple precedes B's in source-of-truth
 *   write order), the lex-string encoding produced by
 *   `${timestamp(A.t)}_<sess>_${countKey(A.s)}` satisfies
 *   enc(A) > enc(B) lexicographically, and a forward
 *   `Storage.list(prefix)` returns enc(B) before enc(A).
 *
 * Anchors the spec's claim that ascending-lex `ListObjectsV2`
 * iteration over LSN-shaped keys is reverse-causal — i.e.
 * walking the log "backwards in time" needs no in-memory
 * reverse buffer. See `docs/spec/sync-protocol.md` §"Subtleties
 * of the manifest key" and `docs/spec/log-entry-shape.md`
 * §"Cursor format".
 */
import { fc, test } from "@fast-check/vitest";
import { describe, expect } from "vitest";
import { COUNT_BIT_WIDTH, TIMESTAMP_BIT_WIDTH } from "./constants.ts";
import { MemoryStorage } from "./storage/memory.ts";
import { timestamp } from "./time.ts";
import { countKey, str2uintDesc, uint2strDesc } from "./types.ts";

/**
 * One causally-ordered write: a (millis-since-epoch, seq) tuple
 * the writer would have produced. `seq` ranges over a window of
 * `COUNT_BIT_WIDTH`'s domain and `millis` ranges over a small
 * recent window so timestamps interleave realistically.
 * The full domain is 0..Number.MAX_SAFE_INTEGER; we test a small
 * window for fast-check performance.
 */
interface CausalPoint {
  readonly millis: number;
  readonly seq: number;
}

/**
 * Fast-check arbitrary: a session id (6 hex chars per the LSN
 * shape) plus N causally-ordered points. We generate raw points
 * unordered, then sort by (millis, seq) to define the
 * source-of-truth causal order against which we compare the
 * lex-list order.
 */
const sessionArb = fc.stringMatching(/^[0-9a-f]{6}$/);
const pointArb: fc.Arbitrary<CausalPoint> = fc.record({
  millis: fc.integer({ min: 0, max: 2 ** TIMESTAMP_BIT_WIDTH - 1 }),
  // COUNT_BIT_WIDTH = 53; Number.MAX_SAFE_INTEGER = 2^53 - 1.
  // fc.maxSafeInteger() covers the full domain; keep it small
  // for fast-check shrink performance.
  seq: fc.maxSafeInteger().filter((n) => n >= 0),
});
const populationArb = fc.record({
  session: sessionArb,
  points: fc.uniqueArray(pointArb, {
    minLength: 2,
    maxLength: 64,
    selector: (p) => `${p.millis}:${p.seq}`,
  }),
});

/** Construct the LSN-shaped key for a CausalPoint under `session`. */
const encodeKey = (p: CausalPoint, session: string): string =>
  `${timestamp(p.millis)}_${session}_${countKey(p.seq)}`;

/**
 * Causal comparator: A < B iff A.millis < B.millis, ties broken
 * by A.seq < B.seq. Returns negative, zero, or positive.
 */
const causalCmp = (a: CausalPoint, b: CausalPoint): number => a.millis - b.millis || a.seq - b.seq;

describe("Patent C3 — descending-base-32 LSN reverse-lex ordering", () => {
  test.prop({ pop: populationArb })(
    "for any pair A causally < B: enc(A) lex-greater-than enc(B)",
    ({ pop }) => {
      const sorted = [...pop.points].toSorted(causalCmp);
      for (let i = 0; i < sorted.length - 1; i++) {
        const a = sorted[i]!;
        const b = sorted[i + 1]!;
        // uniqueArray(selector) guarantees no two points share both millis
        // and seq, so causalCmp(a, b) is strictly non-zero here.
        const keyA = encodeKey(a, pop.session);
        const keyB = encodeKey(b, pop.session);
        // A causally precedes B, so enc(A) must be lex-greater
        // than enc(B) (descending-base-32 reverses the natural order).
        expect(keyA > keyB).toBe(true);
      }
    },
  );

  test.prop({ pop: populationArb })(
    "forward Storage.list yields keys in reverse-causal order",
    async ({ pop }) => {
      const s = new MemoryStorage();
      const prefix = "test/lsn-reverse/";
      // Populate the bucket with zero-byte objects keyed by encoded LSN.
      for (const p of pop.points) {
        await s.put(prefix + encodeKey(p, pop.session), new Uint8Array(0));
      }
      // Read back via the forward-only list API.
      const listed: string[] = [];
      for await (const e of s.list(prefix)) {
        listed.push(e.key.slice(prefix.length));
      }
      // Independently compute the reverse-causal order (newest first).
      const expected = [...pop.points]
        .toSorted((a, b) => -causalCmp(a, b))
        .map((p) => encodeKey(p, pop.session));
      expect(listed).toEqual(expected);
    },
  );

  test.prop({ pop: populationArb })(
    "str2uintDesc round-trips every encoded seq + timestamp",
    ({ pop }) => {
      for (const p of pop.points) {
        expect(str2uintDesc(countKey(p.seq), COUNT_BIT_WIDTH)).toBe(p.seq);
        expect(str2uintDesc(timestamp(p.millis), TIMESTAMP_BIT_WIDTH)).toBe(p.millis);
      }
    },
  );

  test("regression: a hand-picked pair documents the lex-reversal", () => {
    // Two writes one ms apart, same session, seqs 0 then 1.
    // The later write (newer time, higher seq) must sort lex-FIRST.
    const sess = "abc123";
    const earlier = encodeKey({ millis: 1_700_000_000_000, seq: 0 }, sess);
    const later = encodeKey({ millis: 1_700_000_000_001, seq: 1 }, sess);
    expect(later < earlier).toBe(true);
    expect(uint2strDesc(0, 10)).toBe("vv");
    expect(uint2strDesc(1023, 10)).toBe("00");
  });
});
