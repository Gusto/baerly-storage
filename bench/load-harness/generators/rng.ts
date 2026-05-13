/**
 * mulberry32 — a 32-bit-state PRNG with a 2^32 period.
 *
 * Why this and not `pure-rand`, `seedrandom`, or `Math.random()`:
 *
 *   1. Determinism. `Math.random()` is non-seedable; cross-run
 *      reproducibility is impossible without an alternate PRNG.
 *   2. Zero deps. `pure-rand` (the PRNG fast-check uses) and
 *      `seedrandom` both pull in ~50 KB of runtime code and are
 *      themselves only used in tests. CLAUDE.md "anti-patterns"
 *      forbids casual dep growth.
 *   3. Faker-compatible note: the v8→v9 transition reshuffled how
 *      faker's internal PRNG consumes seed bits, so same-seed
 *      determinism across faker majors is NOT guaranteed. The
 *      harness does not depend on faker today, but if a future
 *      preset adopts it, the faker pin must be exact (no `^`, no
 *      `~`) — see ticket 51 §2 for the rationale.
 *
 * Period (2^32 ≈ 4.3e9) covers every preset's worst-case op count
 * (~10^7) with ~400× headroom. Statistical quality is fine for
 * synthetic workload generation; DO NOT use for crypto.
 *
 * Reference implementation: https://stackoverflow.com/a/47593316
 * (original author: Tommy Ettinger; public domain).
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Seeded-RNG wrapper with the methods the dataset and op generators
 * need. Mirrors `Math.random()`'s `[0, 1)` contract; the helpers are
 * inline rather than a class so future presets can `import { Rng } …`
 * and inject a different PRNG for A/B testing.
 */
export interface Rng {
  next(): number;
  /** Inclusive low, exclusive high. */
  int(low: number, high: number): number;
  /** Pick one uniformly. */
  pick<T>(xs: readonly T[]): T;
  /** Pick by weights; weights need not sum to 1. */
  weighted<T>(xs: readonly T[], weights: readonly number[]): T;
  /** Zipf-shaped index in [0, n). `s > 1` skews to low indices. */
  zipfIndex(n: number, s: number): number;
  /** Power-law sample in [lo, hi]; `alpha > 1` skews to lo. */
  powerLaw(lo: number, hi: number, alpha: number): number;
}

export function makeRng(seed: number): Rng {
  const r = mulberry32(seed);
  return {
    next: r,
    int(low, high) {
      return Math.floor(r() * (high - low)) + low;
    },
    pick(xs) {
      return xs[Math.floor(r() * xs.length)]!;
    },
    weighted(xs, weights) {
      const total = weights.reduce((a, b) => a + b, 0);
      let pick = r() * total;
      for (let i = 0; i < xs.length; i++) {
        pick -= weights[i]!;
        if (pick <= 0) return xs[i]!;
      }
      return xs[xs.length - 1]!;
    },
    zipfIndex(n, s) {
      // Inverse-CDF rejection. Cheap for s in [1.2, 2.5] range used
      // by every Phase-11 preset.
      const u = r();
      const idx = Math.floor(Math.pow(1 - u, -1 / (s - 1)));
      return Math.min(n - 1, Math.max(0, idx - 1));
    },
    powerLaw(lo, hi, alpha) {
      // Inverse-CDF for x ∝ x^(-alpha), x ∈ [lo, hi].
      const u = r();
      const x = Math.pow(
        u * (Math.pow(hi, 1 - alpha) - Math.pow(lo, 1 - alpha)) + Math.pow(lo, 1 - alpha),
        1 / (1 - alpha),
      );
      return Math.min(hi, Math.max(lo, x));
    },
  };
}
