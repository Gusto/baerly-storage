/**
 * The static tree op model (`bench/tree-op-model/model.ts`) bounds the
 * storage calls the prototype tree really makes.
 *
 * `bench/tree-op-model/crosscheck.ts` builds real trees at the production
 * layout (256 B and 5 KiB documents, at depth 0, 1 and 2, the last at
 * Paid's fold ceilings), measures a cold point read, a complete scan, a
 * one-pass fold tick and a budget-bound fold tick with counting storage,
 * happy path and with every retried call at every attempt, and evaluates
 * the model for the same cell. A tick's measured count includes the
 * calls composed from main's measured counts (the runner's head GET and
 * the closing `tail_hint` refresh); see `bench/tree-op-model/measure.ts`.
 *
 * Every cell must be measured ≤ modelled, per kind (GETs, PUTs) and in
 * total, so a model that drops the path GETs fails here even where its
 * create term has slack. Every Paid cell and the Free + R2 depth-0 tick
 * must also fit their assigned residual request budget. Budget-bound
 * ticks stress the fold with a longer tail while retaining the normal
 * route-read allowance; they do not measure a whole write invocation.
 */
import { beforeAll, describe, expect, test } from "vitest";
import {
  cellName,
  type CrossCell,
  exceedances,
  runCrosscheck,
  TREE_SPECS,
} from "../../bench/tree-op-model/crosscheck.ts";
import { totalOf } from "../../bench/tree-op-model/measure.ts";
import { ciTimeout } from "../setup/ci.ts";

let cells: CrossCell[] = [];

beforeAll(async () => {
  cells = await runCrosscheck();
}, ciTimeout(60_000));

describe("tree op model against counting-storage measurements", () => {
  test("every depth Paid C/E reaches is measured, at both document sizes", () => {
    for (const spec of TREE_SPECS) {
      const of = cells.filter((c) => c.docBytes === spec.docBytes && c.depth === spec.depth);
      const names = new Set(of.map((c) => `${c.host} ${c.op} ${c.policy}`));
      const paidOps = ["point", "scan", "tick-pass", "tick-budget"];
      // Free publishes depth-0 roots only, so it has a tick at depth 0 alone.
      const freeOps = spec.depth === 0 ? paidOps : ["point", "scan"];
      const expected = ["happy", "all"].flatMap((policy) =>
        paidOps
          .map((op) => `Paid ${op} ${policy}`)
          .concat(freeOps.map((op) => `Free + R2 ${op} ${policy}`)),
      );
      expect([...names].toSorted(), `${spec.docBytes} B depth ${spec.depth}`).toEqual(
        expected.toSorted(),
      );
    }
    expect(Math.max(...cells.map((c) => c.depth))).toBe(2);
  });

  test("measured <= modelled for every cell, per kind and in total", () => {
    expect(cells.flatMap((c) => exceedances(c).map((e) => `${cellName(c)}: ${e}`))).toEqual([]);
  });

  test("every Paid cell and the Free + R2 depth-0 tick fit their request budget", () => {
    const over = cells
      .filter((c) => c.host === "Paid" || c.op !== "scan" || c.depth === 0)
      .filter((c) => c.refused === true || totalOf(c.measured) > c.budget)
      .map((c) => `${cellName(c)}: ${totalOf(c.measured)} of ${c.budget}`);
    expect(over).toEqual([]);
  });

  test("a budget-bound tick with every attempt charged spends at most its budget", () => {
    const ticks = cells.filter((c) => c.op === "tick-budget" && c.policy === "all");
    expect(ticks.length).toBeGreaterThan(0);
    const over = ticks
      .filter((c) => totalOf(c.measured) > c.budget)
      .map((c) => `${cellName(c)}: ${totalOf(c.measured)} of ${c.budget}`);
    expect(over).toEqual([]);
  });
});
