/**
 * Canonical-root acceptance for the prototype tree's fold planner,
 * exhaustive at the small-scope layout: every change set over two or
 * three `_id`s from a pool of IDs before the first row, at the first
 * and last rows, in a gap, at isolated documents and after the last row,
 * folded onto deep backgrounds in one tick (and, for two IDs, one tick
 * per change). After every tick the published tree must be the
 * canonical tree of the logical oracle's rows
 * (`tests/fixtures/tree-fold-harness.ts`). The `mutation` tests require
 * each planner mutant in `tests/fixtures/tree-mutants.ts` to be caught.
 */
import { describe, expect, test } from "vitest";
import type { DocumentData } from "@baerly/protocol";
import { buildTree } from "../../packages/server/src/tree/build.ts";
import { canonicalDocument } from "../../packages/server/src/tree/node-codec.ts";
import {
  configOf,
  FoldRun,
  type RowChange,
  runTicks,
  SMALL_LAYOUT,
  sizedRow,
} from "../fixtures/tree-fold-harness.ts";
import { testChunkKey } from "../fixtures/tree-chunk-salt.ts";
import { PLAN_MUTANTS, type TreeMutant } from "../fixtures/tree-mutants.ts";

/** Background row sets, each deep at the small-scope layout. */
const BACKGROUNDS: readonly { readonly name: string; readonly rows: readonly RowChange[] }[] = [
  {
    // Mixed sizes with isolated documents (48 bytes and up) between short ones.
    name: "mixed sizes with isolated documents",
    rows: Array.from({ length: 16 }, (_, i) => ({
      id: `k${i}`,
      value: sizedRow(`k${i}`, [12, 30, 48, 20, 12, 52, 25, 12][i % 8]!),
    })),
  },
  {
    // The depth-2 vector tree: k0..k19, 11-12 bytes each.
    name: "k0..k19",
    rows: Array.from({ length: 20 }, (_, i) => ({ id: `k${i}`, value: { _id: `k${i}` } })),
  },
];

/**
 * IDs to change: before the first row, the first row, a gap, rows that
 * are isolated in the mixed background (`k10` at exactly
 * `leafIsolationDocumentBytes`, `k13` and `k5` above it), the last row
 * and after the last.
 */
const POOL = ["j", "k0", "k10", "k105", "k13", "k5", "k9", "l"];

/** Change kinds: delete, or upsert at a short, medium or isolated size. */
const KINDS: readonly ((id: string) => DocumentData | null)[] = [
  () => null,
  (id) => sizedRow(id, 12, "s"),
  (id) => sizedRow(id, 30, "m"),
  (id) => sizedRow(id, 50, "i"),
];

/** Every `size`-element subset of `items`, in order. */
const combinations = <T>(items: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  const pick = (from: number, chosen: T[]): void => {
    if (chosen.length === size) {
      out.push(chosen.slice());
      return;
    }
    for (let i = from; i < items.length; i++) {
      chosen.push(items[i]!);
      pick(i + 1, chosen);
      chosen.pop();
    }
  };
  pick(0, []);
  return out;
};

/** Every tuple of `size` change kinds. */
const kindTuples = (size: number): number[][] =>
  Array.from({ length: KINDS.length ** size }, (_, n) =>
    Array.from({ length: size }, (_unused, i) => Math.floor(n / KINDS.length ** i) % KINDS.length),
  );

/** Every exhaustive change set over two or three pool IDs. */
const exhaustiveChangeSets = (): RowChange[][] => {
  const sets: RowChange[][] = [];
  for (const size of [2, 3]) {
    for (const ids of combinations(POOL, size)) {
      for (const kinds of kindTuples(size)) {
        sets.push(ids.map((id, i) => ({ id, value: KINDS[kinds[i]!]!(id) })));
      }
    }
  }
  return sets;
};

/**
 * Run every exhaustive change set onto every background under `mutant`:
 * in one tick, and two-ID sets also one tick per change. Returns the
 * first failure, or `undefined`.
 */
const firstExhaustiveFailure = async (mutant?: TreeMutant): Promise<string | undefined> => {
  const config = configOf(SMALL_LAYOUT, mutant);
  const canonical = configOf(SMALL_LAYOUT);
  for (const { name, rows } of BACKGROUNDS) {
    const seeded = await FoldRun.open(config);
    await seeded.fold(rows);
    for (const changes of exhaustiveChangeSets()) {
      const label = `${name}: ${changes.map((c) => `${c.value === null ? "D" : "U"}(${c.id})`).join(" ")}`;
      const oneTick = await runTicks(config, [changes], canonical, seeded.fork());
      if (oneTick !== undefined) {
        return `${label} in one tick: ${oneTick}`;
      }
      if (changes.length > 2) {
        continue;
      }
      const perChange = await runTicks(
        config,
        changes.map((c) => [c]),
        canonical,
        seeded.fork(),
      );
      if (perChange !== undefined) {
        return `${label} one tick per change: ${perChange}`;
      }
    }
  }
  return undefined;
};

describe("exhaustive small scope", () => {
  test("the backgrounds are deep trees with isolated leaves", async () => {
    const config = configOf(SMALL_LAYOUT);
    const key = await testChunkKey();
    const [mixed, plain] = await Promise.all(
      BACKGROUNDS.map(({ rows }) =>
        buildTree(
          rows.map((r) => canonicalDocument(r.value, "row")),
          key,
          config,
        ),
      ),
    );
    expect(plain!.root.level).toBe(2);
    expect(mixed!.root.level).toBeGreaterThanOrEqual(2);
    expect(exhaustiveChangeSets()).toHaveLength(28 * 16 + 56 * 64);
  });

  test("every change set over two or three IDs folds to the canonical root", async () => {
    await expect(firstExhaustiveFailure()).resolves.toBeUndefined();
  }, 60_000);

  describe("mutation", () => {
    test.each(PLAN_MUTANTS.map((mutant) => [mutant.name, mutant] as const))(
      "%s is caught",
      async (_name, mutant) => {
        await expect(firstExhaustiveFailure(mutant)).resolves.toBeDefined();
      },
      60_000,
    );
  });
});
