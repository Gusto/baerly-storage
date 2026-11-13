/**
 * Request-count gate: every route and maintenance tick in the grid issues
 * exactly the storage calls `request-counts.json` records. Policy and the
 * rebaseline ritual: docs/contributing/conventions/request-counts.md.
 */

import { describe, expect, test } from "vitest";
import {
  compareCounts,
  formatCell,
  formatChanges,
  loadRequestCountSnapshot,
  parseCell,
} from "../../scripts/request-counts.ts";
import { measureRequestCounts } from "../fixtures/request-count-grid.ts";
import { CallTally, requestCountingStorage } from "../fixtures/request-counting-storage.ts";
import { MemoryStorage } from "@baerly/protocol";

describe("request-counts.json", () => {
  test("every grid cell issues exactly its committed storage calls", async () => {
    const changes = compareCounts(loadRequestCountSnapshot(), await measureRequestCounts());
    // Thrown as text so a failure prints the per-cell diff once, readably.
    if (changes.length > 0) {
      throw new Error(formatChanges(changes));
    }
    expect(changes).toHaveLength(0);
  });
});

describe("request-counts format", () => {
  const before = { get: 5, put: 1, delete: 0, listPage: 0 };

  test("a cell round-trips through its on-disk form", () => {
    expect(formatCell(before)).toBe("get=5 put=1 delete=0 listPage=0 total=6");
    expect(parseCell("c", formatCell(before))).toEqual(before);
  });

  test("a changed cell names the kinds that moved and the total", () => {
    const changes = compareCounts(
      { cells: { "insert tail=0": formatCell(before), gone: formatCell(before) } },
      { "insert tail=0": { ...before, get: 6 }, fresh: before },
    );
    expect(formatChanges(changes).split("\n").slice(0, 4)).toEqual([
      "request-counts: 3 cell(s) differ from request-counts.json",
      "CHANGED insert tail=0: get 5 -> 6 (+1), total 6 -> 7 (+1)",
      "ADDED   fresh: get=5 put=1 delete=0 listPage=0 total=6",
      "REMOVED gone: was get=5 put=1 delete=0 listPage=0 total=6",
    ]);
  });
});

describe("requestCountingStorage", () => {
  test("charges one listPage per 1000 keys pulled, and one for an empty list", async () => {
    const inner = new MemoryStorage();
    for (let i = 0; i < 2001; i++) {
      await inner.put(`k/${String(i).padStart(4, "0")}`, new Uint8Array());
    }
    const tally = new CallTally();
    const counted = requestCountingStorage(inner, tally);
    let n = 0;
    for await (const _ of counted.list("k/")) {
      n += 1;
    }
    expect(n).toBe(2001);
    for await (const _ of counted.list("none/")) {
      n += 1;
    }
    expect(tally.read()).toEqual({ get: 0, put: 0, delete: 0, listPage: 4 });
  });
});
