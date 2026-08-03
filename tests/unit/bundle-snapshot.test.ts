import { describe, expect, test } from "vitest";
import {
  blocksWrite,
  compareSnapshot,
  deltaLimit,
  formatReportLine,
  formatViolation,
  loadSnapshot,
  nextSnapshot,
  type Snapshot,
  ungatedAxes,
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

// The delta gate can only compare against a baseline it has. An entry whose
// tier gates an axis it carries no number for is therefore not gated leniently
// — it is not gated at all, and `compareSnapshot` cannot say so, because a
// missing baseline is indistinguishable from an axis the tier never gated.
// `ungatedAxes` is what makes that state visible before it can be committed.
describe("ungatedAxes", () => {
  test("compareSnapshot is silent on a tier-gated axis with no baseline", () => {
    // The premise. A hand-added entry measuring 99 MB draws no violation,
    // which is why the check below has to exist outside compareSnapshot.
    const entries = { "index.js": { tier: "shipped", note: "hand-added" } };
    expect(
      compareSnapshot(snap(entries), { "index.js": { raw: 99e6, gz: 9e6, minGz: 9e5 } }),
    ).toEqual([]);
  });

  test("flags every tier-gated axis a hand-added entry has yet to measure", () => {
    // Exactly the state `pnpm bundle-sizes`'s own error message asks for:
    // add the entry with a `tier` and a `note`, then `--write` to fill it in.
    const entries = { "index.js": { tier: "shipped", note: "hand-added" } };
    expect(ungatedAxes(snap(entries))).toEqual([
      { entry: "index.js", axis: "raw" },
      { entry: "index.js", axis: "gz" },
      { entry: "index.js", axis: "minGz" },
    ]);
  });

  test("flags a single missing axis on an otherwise measured entry", () => {
    const entries = { "index.js": { tier: "shipped", raw: 1, gz: 2, note: "n" } };
    expect(ungatedAxes(snap(entries))).toEqual([{ entry: "index.js", axis: "minGz" }]);
  });

  test("does not flag an axis the entry's tier never gates", () => {
    // tooling reads raw only, so a missing gz is correct, not a gap.
    const entries = { "dev.js": { tier: "tooling", raw: 1000, note: "n" } };
    expect(ungatedAxes(snap(entries))).toEqual([]);
  });

  test("a fully measured snapshot has nothing ungated", () => {
    const entries = {
      "index.js": { tier: "shipped", raw: 100000, gz: 30000, minGz: 10000, note: "n" },
    };
    expect(ungatedAxes(snap(entries))).toEqual([]);
  });

  test("the committed snapshot is fully gated", () => {
    // The gate this repo actually runs. If this fails, some entry is green
    // because nothing compares it, not because it did not grow.
    expect(ungatedAxes(loadSnapshot())).toEqual([]);
  });
});

// The failure path is the only output an author ever reads, and it is the one
// the test suite never reaches — every green run asserts `violations` is empty.
// Its predecessor `formatBundleSizeLine` carried unit tests; this keeps that
// coverage rather than dropping it with the budget loop.
describe("formatViolation", () => {
  test("a delta violation names the growth, the percentage and the way out", () => {
    expect(
      formatViolation(
        {
          kind: "delta",
          entry: "index.js",
          axis: "raw",
          baseline: 100000,
          measured: 110000,
          limit: 2000,
        },
        256,
      ),
    ).toBe(
      [
        "FAIL index.js raw 100000 -> 110000 (+10000, +10.0%) exceeds max(tier%, 256B)",
        "     If intended: `pnpm bundle-sizes --write`, and say why in the commit message.",
        "     Do NOT trim JSDoc, comments, or error text to fit — those ship",
        "     un-stripped in raw/gz but vanish under a consumer's minifier.",
      ].join("\n"),
    );
  });

  // `minGz` is a JSON field name. An author who sees it in the failure text
  // and `min-gz` everywhere else has to work out that they are one axis.
  test("spells minGz the way every other line does", () => {
    const out = formatViolation(
      {
        kind: "delta",
        entry: "index.js",
        axis: "minGz",
        baseline: 10000,
        measured: 11000,
        limit: 200,
      },
      256,
    );
    expect(out).toContain("FAIL index.js min-gz 10000 -> 11000");
    expect(out).not.toContain("minGz");
  });

  test("a ceiling violation says --write will not clear it", () => {
    // The distinction the whole `blocksWrite` split exists for: an agent that
    // reads "rebaseline" here would burn a cycle on a command that refuses.
    const out = formatViolation(
      { kind: "ceiling", entry: "app-config.js", axis: "gz", ceiling: 512, measured: 900 },
      256,
    );
    expect(out).toContain("exceeds HARD CEILING 512 (+388)");
    expect(out).toContain("`--write` will NOT clear this");
    expect(out).not.toContain("If intended");
  });
});

// The exact string is the contract: agents are told to grep `--report` output,
// so the shape is pinned here rather than left to whatever console.log does.
describe("formatReportLine", () => {
  const shipped = { tier: "shipped", raw: 100000, gz: 30000, minGz: 10000, note: "n" };

  test("carries measured size and delta from baseline on every axis", () => {
    expect(formatReportLine("index.js", { raw: 100260, gz: 29988, minGz: 10000 }, shipped)).toBe(
      "BUNDLE_SIZE index.js raw=100260(+260,+0.3%) gz=29988(-12,-0.0%) min-gz=10000(+0,+0.0%)",
    );
  });

  test("an axis with no committed baseline reports the measurement alone", () => {
    const tooling = { tier: "tooling", raw: 1000, note: "n" };
    expect(formatReportLine("node.js", { raw: 1100, gz: 400 }, tooling)).toBe(
      "BUNDLE_SIZE node.js raw=1100(+100,+10.0%) gz=400",
    );
  });

  test("an unmeasured axis is absent, not reported as zero", () => {
    expect(formatReportLine("node.js", { raw: 100000, gz: 30000 }, shipped)).toBe(
      "BUNDLE_SIZE node.js raw=100000(+0,+0.0%) gz=30000(+0,+0.0%)",
    );
  });
});

// `--write` is the path an agent reaches for the moment the gate trips, so
// what it preserves is as load-bearing as what the gate rejects: a rebaseline
// that quietly dropped a `hardCeiling` would convert a structural commitment
// into a delta baseline, and the next regeneration would ratify whatever the
// closure weighed by then.
describe("nextSnapshot", () => {
  const shipped: Snapshot["entries"] = {
    "index.js": { tier: "shipped", raw: 100000, gz: 30000, minGz: 10000, note: "kernel barrel" },
  };

  test("refreshes every measured axis the tier gates", () => {
    const next = nextSnapshot(snap(shipped), {
      "index.js": { raw: 111111, gz: 33333, minGz: 11111 },
    });
    expect(next.entries["index.js"]).toMatchObject({ raw: 111111, gz: 33333, minGz: 11111 });
  });

  test("carries hand-maintained tier, note and hardCeiling through untouched", () => {
    const entries: Snapshot["entries"] = {
      "app-config.js": {
        tier: "shipped",
        raw: 167,
        gz: 147,
        minGz: 70,
        hardCeiling: { raw: 1024, gz: 512 },
        note: "no runtime closure",
      },
    };
    const next = nextSnapshot(snap(entries), { "app-config.js": { raw: 200, gz: 160, minGz: 80 } });
    expect(next.entries["app-config.js"]).toEqual({
      tier: "shipped",
      raw: 200,
      gz: 160,
      minGz: 80,
      hardCeiling: { raw: 1024, gz: 512 },
      note: "no runtime closure",
    });
  });

  test("does not write an axis the entry's tier never gates", () => {
    // dev.js is measured on gz for free, but the tooling tier reads raw only.
    // Writing gz anyway would commit a baseline nothing compares against.
    const entries: Snapshot["entries"] = { "dev.js": { tier: "tooling", raw: 1000, note: "n" } };
    const next = nextSnapshot(snap(entries), { "dev.js": { raw: 1100, gz: 400 } });
    expect(next.entries["dev.js"]).toEqual({ tier: "tooling", raw: 1100, note: "n" });
  });

  test("writes an axis a hard ceiling needs even when the tier omits it", () => {
    const entries: Snapshot["entries"] = {
      "dev.js": { tier: "tooling", raw: 1000, note: "n", hardCeiling: { gz: 9999 } },
    };
    const next = nextSnapshot(snap(entries), { "dev.js": { raw: 1100, gz: 400 } });
    expect(next.entries["dev.js"]?.gz).toBe(400);
  });

  test("keeps the committed baseline for an entry with no measurement", () => {
    // Unreachable from the CLI (`compareSnapshot` throws first), but dropping
    // a baseline here would silently retire that entry's gate.
    expect(nextSnapshot(snap(shipped), {}).entries["index.js"]).toEqual(shipped["index.js"]);
  });

  test("emits a canonical key order, so two regenerations are byte-identical", () => {
    // Same measurement, entry authored with keys out of order.
    const scrambled: Snapshot["entries"] = {
      "index.js": { note: "kernel barrel", minGz: 1, tier: "shipped", gz: 1, raw: 1 },
    };
    const measured = { "index.js": { raw: 100000, gz: 30000, minGz: 10000 } };
    const once = nextSnapshot(snap(scrambled), measured);
    expect(Object.keys(once.entries["index.js"]!)).toEqual(["tier", "raw", "gz", "minGz", "note"]);
    expect(JSON.stringify(nextSnapshot(once, measured))).toBe(JSON.stringify(once));
  });

  test("preserves a field the schema grows later", () => {
    const entries = {
      "index.js": { ...shipped["index.js"]!, futureField: "keep me" },
    } as Snapshot["entries"];
    const next = nextSnapshot(snap(entries), { "index.js": { raw: 1, gz: 1, minGz: 1 } });
    expect(next.entries["index.js"]).toHaveProperty("futureField", "keep me");
  });

  test("does not mutate the snapshot it was handed", () => {
    const original = snap(shipped);
    nextSnapshot(original, { "index.js": { raw: 999999, gz: 999999, minGz: 999999 } });
    expect(original.entries["index.js"]?.raw).toBe(100000);
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
