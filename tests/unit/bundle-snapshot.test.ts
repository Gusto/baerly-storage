import { describe, expect, test } from "vitest";
import {
  blocksWrite,
  compareSnapshot,
  deltaLimit,
  type Snapshot,
} from "../../scripts/bundle-sizes.ts";

const policy = {
  floorBytes: 256,
  tiers: {
    shipped: { pct: 0.02, axes: ["raw", "gz", "minGz"] as const },
    tooling: { pct: 0.1, axes: ["raw"] as const },
  },
};

const snap = (entries: Snapshot["entries"]): Snapshot => ({ policy, entries });

describe("deltaLimit", () => {
  test("uses the percentage term when it exceeds the floor", () => {
    expect(deltaLimit(238553, 0.02, 256)).toBeCloseTo(4771.06, 1);
  });

  test("uses the floor when the percentage term is smaller", () => {
    // client.js min-gz: 2% of 2254 is 45 B, far too tight for one error string.
    expect(deltaLimit(2254, 0.02, 256)).toBe(256);
  });
});

describe("compareSnapshot", () => {
  const shipped = {
    "index.js": { tier: "shipped", raw: 100000, gz: 30000, minGz: 10000, note: "n" },
  };

  test("growth under the threshold does not trip", () => {
    const v = compareSnapshot(snap(shipped), {
      "index.js": { raw: 101000, gz: 30100, minGz: 10100 }, // +1%, +0.33%, +1%
    });
    expect(v).toEqual([]);
  });

  test("growth over the threshold trips, naming entry and axis", () => {
    const v = compareSnapshot(snap(shipped), {
      "index.js": { raw: 105000, gz: 30100, minGz: 10100 }, // raw +5%
    });
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({
      kind: "delta",
      entry: "index.js",
      axis: "raw",
      baseline: 100000,
      measured: 105000,
    });
  });

  test("a shrink never trips", () => {
    const v = compareSnapshot(snap(shipped), {
      "index.js": { raw: 50000, gz: 15000, minGz: 5000 },
    });
    expect(v).toEqual([]);
  });

  test("every over-threshold axis is reported, not just the first", () => {
    const v = compareSnapshot(snap(shipped), {
      "index.js": { raw: 110000, gz: 33000, minGz: 11000 },
    });
    expect(v.map((x) => x.axis).toSorted()).toEqual(["gz", "minGz", "raw"]);
  });

  test("min-gz over a hard ceiling trips even when the delta is small", () => {
    const entries = {
      "client.js": {
        tier: "shipped",
        raw: 15822,
        gz: 5514,
        minGz: 4000,
        hardCeiling: { minGz: 4096 },
        note: "browser client",
      },
    };
    const v = compareSnapshot(snap(entries), {
      "client.js": { raw: 15822, gz: 5514, minGz: 4200 }, // +200 B: under 256 floor
    });
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({
      kind: "ceiling",
      entry: "client.js",
      axis: "minGz",
      ceiling: 4096,
    });
  });

  test("a ceiling violation blocks --write; a delta violation does not", () => {
    expect(
      blocksWrite({ kind: "ceiling", entry: "e", axis: "minGz", ceiling: 1, measured: 2 }),
    ).toBe(true);
    expect(
      blocksWrite({ kind: "delta", entry: "e", axis: "raw", baseline: 1, measured: 2, limit: 1 }),
    ).toBe(false);
  });

  test("the tooling tier gates raw only, at 10%", () => {
    const entries = {
      "node.js": { tier: "tooling", raw: 582904, note: "server-only" },
    };
    // +5% raw would trip the shipped tier but not tooling.
    expect(compareSnapshot(snap(entries), { "node.js": { raw: 612049, gz: 999999 } })).toEqual([]);
    // +15% raw trips.
    const v = compareSnapshot(snap(entries), { "node.js": { raw: 670340, gz: 999999 } });
    expect(v).toHaveLength(1);
    expect(v[0]!.axis).toBe("raw");
  });

  test("an axis absent from the snapshot is not gated", () => {
    const entries = { "node.js": { tier: "tooling", raw: 1000, note: "n" } };
    // gz balloons, but tooling does not gate gz and no gz baseline exists.
    expect(compareSnapshot(snap(entries), { "node.js": { raw: 1000, gz: 500000 } })).toEqual([]);
  });

  test("an unknown tier is a loud error, not a silent pass", () => {
    const entries = { "x.js": { tier: "nope", raw: 1000, note: "n" } };
    expect(() => compareSnapshot(snap(entries), { "x.js": { raw: 99999, gz: 1 } })).toThrow(
      /unknown tier/i,
    );
  });

  test("a snapshot entry with no measurement is a loud error", () => {
    expect(() => compareSnapshot(snap(shipped), {})).toThrow(/index\.js/);
  });
});

// Replay of real historical deltas, so a future threshold change shows its
// effect on this repo's actual history instead of on intuition. Values are
// measured sizes recorded in the pre-2026-08 budget-history comments.
describe("historical backtest", () => {
  const HISTORY: ReadonlyArray<{ entry: string; axis: "raw" | "gz"; from: number; to: number }> = [
    { entry: "client-react.js", axis: "raw", from: 15268, to: 22522 }, // +47.5%
    { entry: "index.js", axis: "raw", from: 166684, to: 211008 }, //     +26.6% in-band maintenance
    { entry: "auth.js", axis: "raw", from: 55803, to: 67752 }, //        +21.4% WS4 constants-chunk regression
    { entry: "http.js", axis: "raw", from: 287051, to: 318946 }, //      +11.1%
    { entry: "observability.js", axis: "raw", from: 93936, to: 98776 }, // +5.2% logtape bump
    { entry: "cloudflare.js", axis: "raw", from: 371087, to: 385000 }, //  +3.7%
    { entry: "http.js", axis: "gz", from: 93115, to: 95564 }, //           +2.6%
    { entry: "index.js", axis: "raw", from: 220302, to: 225667 }, //       +2.4%
    { entry: "index.js", axis: "raw", from: 236371, to: 236768 }, //       +0.17% routine
    { entry: "index.js", axis: "raw", from: 236768, to: 238198 }, //       +0.60% routine
    { entry: "maintenance.js", axis: "raw", from: 129227, to: 129693 }, // +0.36% routine
    { entry: "maintenance.js", axis: "raw", from: 129693, to: 130752 }, // +0.82% routine
  ];

  test("the shipped-tier policy trips exactly the eight significant changes", () => {
    const tripped = HISTORY.filter(
      (h) => h.to - h.from > deltaLimit(h.from, policy.tiers.shipped.pct, policy.floorBytes),
    );
    expect(tripped).toHaveLength(8);
    // The four routine sub-1% increments stay silent — that is the thrash this replaces.
    expect(tripped.every((h) => (h.to - h.from) / h.from > 0.02)).toBe(true);
  });
});
