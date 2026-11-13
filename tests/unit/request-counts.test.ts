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
import { INDEX_COUNTS, measureRequestCounts } from "../fixtures/request-count-grid.ts";
import { FREE_FETCH_BUDGET, freeFetchCells } from "../fixtures/request-count-free-fetch.ts";
import { chargedStorage } from "../fixtures/ledgered-storage.ts";
import { SINCE_HOSTS, sinceCells } from "../fixtures/request-count-since.ts";
import { totalCalls } from "../fixtures/request-counting-storage.ts";
import {
  createObservabilityContext,
  runWithContext,
} from "../../packages/server/src/observability/context.ts";
import {
  CF_FREE_EXTERNAL_REQUEST_LIMIT,
  CF_FREE_FETCH_FOLD_AT_TAIL_ENTRIES,
  CF_FREE_INTERNAL_REQUEST_LIMIT,
  CF_FREE_FETCH_GC_MAX_SWEEPS,
  GC_STARVATION_GUARD,
  MemoryStorage,
  WRITE_TICK_GC_INTERVAL,
} from "@baerly/protocol";

/**
 * The whole grid runs in one test: about 3 s alone, so the default 5 s
 * timeout flakes when the suite runs beside other CPU-bound work.
 */
const GRID_TIMEOUT_MS = 30_000;

describe("request-counts.json", () => {
  test(
    "every grid cell issues exactly its committed storage calls",
    async () => {
      const changes = compareCounts(loadRequestCountSnapshot(), await measureRequestCounts());
      // Thrown as text so a failure prints the per-cell diff once, readably.
      if (changes.length > 0) {
        throw new Error(formatChanges(changes));
      }
      expect(changes).toHaveLength(0);
    },
    GRID_TIMEOUT_MS,
  );
});

describe("Workers Free with storage over fetch", () => {
  test("guaranteed GC sweep throughput exceeds snapshot creation", () => {
    expect(CF_FREE_FETCH_GC_MAX_SWEEPS * CF_FREE_FETCH_FOLD_AT_TAIL_ENTRIES).toBeGreaterThan(
      WRITE_TICK_GC_INTERVAL * GC_STARVATION_GUARD,
    );
  });
  // Each `free-fetch:*` cell is a whole request, route plus the tick it
  // dispatches; the Worker's Cache API calls share the same quota.
  test.each(INDEX_COUNTS)(
    "every request at %i indexes fits the external subrequest budget",
    async (indexes) => {
      const cells = await freeFetchCells(indexes);
      const over = cells
        .map((c) => ({ name: c.name, calls: totalCalls(c.counts) + c.cacheApiCalls }))
        .filter((c) => c.calls > FREE_FETCH_BUDGET);
      expect(over).toEqual([]);
    },
  );
});

describe("GET /v1/since on Workers Free", () => {
  // The cells run under the Free ledger, so a call past a limit would be
  // refused; these pin that the route stays inside it rather than
  // throwing, and that an idle poll spends nearly all of it holding.
  test("idle and busy long-polls stay within each host's request limit", async () => {
    const limit = {
      external: CF_FREE_EXTERNAL_REQUEST_LIMIT,
      internal: CF_FREE_INTERNAL_REQUEST_LIMIT,
    };
    const cells = await sinceCells();
    for (const host of SINCE_HOSTS) {
      const hostLimit = limit[host.pool];
      const over = cells
        .filter((c) => c.name.startsWith(`${host.name}:`) && totalCalls(c.counts) > hostLimit)
        .map((c) => c.name);
      expect(over).toEqual([]);
      const idle = cells.find((c) => c.name === `${host.name}:since-idle-no-timeout`)!;
      // Two calls per idle cycle: all but an odd one left over.
      expect(totalCalls(idle.counts)).toBe(hostLimit - (hostLimit % 2));
    }
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

describe("chargedStorage", () => {
  test("charges one listPage per 1000 keys pulled, and one for an empty list", async () => {
    const inner = new MemoryStorage();
    for (let i = 0; i < 2001; i++) {
      await inner.put(`k/${String(i).padStart(4, "0")}`, new Uint8Array());
    }
    const charged = chargedStorage(inner, "external");
    let n = 0;
    await runWithContext(createObservabilityContext({ ledger: charged.ledger }), async () => {
      for await (const _ of charged.storage.list("k/")) {
        n += 1;
      }
      expect(n).toBe(2001);
      for await (const _ of charged.storage.list("none/")) {
        n += 1;
      }
    });
    expect(charged.read()).toEqual({ get: 0, put: 0, delete: 0, listPage: 4 });
    expect(charged.ledger.charged).toEqual({ internal: 4, external: 4, cache: 0 });
  });

  test("a page boundary at exactly 1000 keys issues no empty follow-up page", async () => {
    const inner = new MemoryStorage();
    for (let i = 0; i < 1000; i++) {
      await inner.put(`k/${String(i).padStart(4, "0")}`, new Uint8Array());
    }
    const charged = chargedStorage(inner, "internal");
    await runWithContext(createObservabilityContext({ ledger: charged.ledger }), async () => {
      for await (const _ of charged.storage.list("k/")) {
        // drain
      }
    });
    expect(charged.read().listPage).toBe(1);
  });

  test("read() fails when the work ran outside the ledger's context", async () => {
    const charged = chargedStorage(new MemoryStorage(), "internal");
    await charged.storage.get("k");
    expect(() => charged.read()).toThrow(/request ledger charged internal=0/);
  });
});
