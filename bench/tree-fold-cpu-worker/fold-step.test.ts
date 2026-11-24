import {
  MAINTENANCE_PROFILE_CF_PAID,
  MAINTENANCE_PROFILE_NODE,
  MemoryStorage,
  type Storage,
} from "@baerly/protocol";
import { TREE_FOLD_TICK_BUDGET_MS } from "../../packages/server/src/tree/constants.ts";
import { describe, expect, test, vi } from "vitest";
import { cellByName, CELLS, FIXTURES, headKey, savedHeadKey, selectCells } from "./cells.ts";
import { buildFixture, fixtureText } from "./fixtures.ts";
import { type FoldStepResult, retrying, runFoldStep, sampleProblem } from "./fold-step.ts";
import { type ResetBucket, resetTenant } from "./reset.ts";

vi.setConfig({ testTimeout: 60_000 });

describe("cell grid", () => {
  test("every fixture has every cap on both storages, names unique", () => {
    expect(CELLS).toHaveLength(FIXTURES.length * 4 * 2);
    expect(new Set(CELLS.map((c) => c.name)).size).toBe(CELLS.length);
    expect(cellByName("d1k5-ledger-r2")).toMatchObject({ cap: null, storage: "r2" });
    expect(cellByName("d2b256-500-memory")).toMatchObject({ cap: 500, storage: "memory" });
  });

  test("patterns select by name or dash-bounded prefix", () => {
    expect(selectCells([]).length).toBe(CELLS.length);
    expect(selectCells(["*"]).length).toBe(CELLS.length);
    expect(selectCells(["d1k5"]).map((c) => c.name)).toEqual([
      "d1k5-100-r2",
      "d1k5-100-memory",
      "d1k5-500-r2",
      "d1k5-500-memory",
      "d1k5-1000-r2",
      "d1k5-1000-memory",
      "d1k5-ledger-r2",
      "d1k5-ledger-memory",
    ]);
    expect(selectCells(["d1k5-ledger", "d0b256-100-r2"]).map((c) => c.name)).toEqual([
      "d0b256-100-r2",
      "d1k5-ledger-r2",
      "d1k5-ledger-memory",
    ]);
    expect(() => selectCells(["d1"])).toThrow(/no cell matches/);
  });
});

describe("sampleProblem", () => {
  const result = (over: Partial<FoldStepResult>): FoldStepResult => ({
    outcome: "published",
    floor: 0,
    foldEnd: 100,
    folded: 100,
    stop: null,
    stopSeq: null,
    nodesWritten: 3,
    ledgerCharged: 200,
    ms: 1,
    ...over,
  });
  const capped = cellByName("d1k5-100-memory")!;
  const whole = cellByName("d1k5-ledger-memory")!;

  test("a capped cell must fold exactly its cut and reach the tail", () => {
    expect(sampleProblem(capped, result({}))).toBeNull();
    expect(sampleProblem(capped, result({ folded: 99, foldEnd: 99 }))).toMatch(/folded 99/);
    expect(sampleProblem(capped, result({ stop: "budget" }))).toMatch(/stop budget/);
  });

  test("a whole-log cell must end on the budget", () => {
    expect(sampleProblem(whole, result({ folded: 2800, stop: "budget" }))).toBeNull();
    expect(sampleProblem(whole, result({ folded: 3200 }))).toMatch(/not the budget/);
    expect(sampleProblem(whole, result({ outcome: "refused", stop: "stuck-entry" }))).toMatch(
      /outcome refused/,
    );
  });
});

describe("fixtures", () => {
  const spec = FIXTURES.find((f) => f.tenant === "d1b256")!;

  test("the build is deterministic and has the specified depth", async () => {
    const a = await buildFixture(spec, 40);
    const b = await buildFixture(spec, 40);
    expect(fixtureText(a.objects)).toBe(fixtureText(b.objects));
    expect(a.manifest).toMatchObject({ depth: 1, rows: 4096, tailEntries: 40 });
    expect(a.manifest.objects).toBe(a.manifest.nodes + 40 + 1);
    expect(a.objects.has(headKey(spec.tenant))).toBe(true);
  });
});

/** A reset bucket over `storage`, paging `list` at 10 keys so the reset must follow cursors. */
const bucketOver = (storage: MemoryStorage): ResetBucket => ({
  async list({ prefix, cursor }) {
    const keys: string[] = [];
    for await (const entry of storage.list(prefix)) {
      keys.push(entry.key);
    }
    keys.sort();
    const start = cursor === undefined ? 0 : Number(cursor);
    const next = start + 10;
    return {
      objects: keys.slice(start, next).map((key) => ({ key })),
      truncated: next < keys.length,
      cursor: String(next),
    };
  },
  async delete(keys) {
    for (const key of keys) {
      await storage.delete(key);
    }
  },
  async get(key) {
    const got = await storage.get(key);
    return got === null ? null : { text: async () => new TextDecoder().decode(got.body) };
  },
  async put(key, value) {
    await storage.put(key, new TextEncoder().encode(value));
  },
});

const image = async (storage: MemoryStorage): Promise<Map<string, string>> => {
  const out = new Map<string, string>();
  for await (const entry of storage.list("")) {
    out.set(entry.key, (await storage.get(entry.key))!.body.toHex());
  }
  return out;
};

describe("fold tick and reset", () => {
  test("a capped tick folds exactly its cut; reset restores the fixture byte for byte", async () => {
    const spec = FIXTURES.find((f) => f.tenant === "d1b256")!;
    const built = await buildFixture(spec, 300);
    const storage = new MemoryStorage();
    const enc = new TextEncoder();
    for (const [key, text] of built.objects) {
      await storage.put(key, enc.encode(text));
    }
    await storage.put(
      savedHeadKey(spec.tenant),
      enc.encode(built.objects.get(headKey(spec.tenant))!),
    );
    const fixture = await image(storage);
    const bucket = bucketOver(storage);
    const cell = cellByName("d1b256-100-memory")!;

    for (let sample = 0; sample < 2; sample++) {
      const result = await runFoldStep(retrying(storage), cell, {
        profile: MAINTENANCE_PROFILE_CF_PAID,
        startedAt: Date.now(),
      });
      expect(sampleProblem(cell, result)).toBeNull();
      expect(result).toMatchObject({ outcome: "published", floor: 0, foldEnd: 100, folded: 100 });
      expect(result.nodesWritten).toBeGreaterThan(1);
      await expect(image(storage)).resolves.not.toEqual(fixture);

      const reset = await resetTenant(bucket, spec.tenant);
      expect(reset).toEqual({
        deleted: result.nodesWritten,
        records: 1,
        nodes: built.manifest.nodes,
      });
      await expect(image(storage)).resolves.toEqual(fixture);
    }
  });

  /** A fresh bucket holding the d1b256 fixture with a `tail`-entry log. */
  const fixtureBucket = async (tail: number): Promise<MemoryStorage> => {
    const built = await buildFixture(
      FIXTURES.find((f) => f.tenant === "d1b256")!,
      tail,
    );
    const storage = new MemoryStorage();
    const enc = new TextEncoder();
    for (const [key, text] of built.objects) {
      await storage.put(key, enc.encode(text));
    }
    return storage;
  };

  test("a tick creates nodes at most its host profile's fold width at once", async () => {
    const cell = cellByName("d1b256-500-memory")!;
    const widest: number[] = [];
    for (const profile of [MAINTENANCE_PROFILE_CF_PAID, MAINTENANCE_PROFILE_NODE]) {
      const inner = await fixtureBucket(500);
      const seen = { inFlight: 0, max: 0 };
      const storage: Storage = {
        ...inner,
        get: (key, opts) => inner.get(key, opts),
        list: (prefix, opts) => inner.list(prefix, opts),
        delete: (key, opts) => inner.delete(key, opts),
        put: async (key, body, opts) => {
          if (!key.includes("/_v99/n/")) {
            return inner.put(key, body, opts);
          }
          seen.inFlight += 1;
          seen.max = Math.max(seen.max, seen.inFlight);
          try {
            await new Promise((resolve) => setTimeout(resolve, 1));
            return await inner.put(key, body, opts);
          } finally {
            seen.inFlight -= 1;
          }
        },
      };
      const result = await runFoldStep(retrying(storage), cell, {
        profile,
        startedAt: Date.now(),
      });
      expect(sampleProblem(cell, result)).toBeNull();
      widest.push(seen.max);
    }
    expect(widest).toEqual([
      MAINTENANCE_PROFILE_CF_PAID.foldParallelCalls,
      MAINTENANCE_PROFILE_NODE.foldParallelCalls,
    ]);
  });

  test("a tick whose request arrived a whole tick budget ago folds one entry and stops on the tick budget", async () => {
    const cell = cellByName("d1b256-100-memory")!;
    const result = await runFoldStep(retrying(await fixtureBucket(300)), cell, {
      profile: MAINTENANCE_PROFILE_CF_PAID,
      startedAt: Date.now() - TREE_FOLD_TICK_BUDGET_MS,
    });
    expect(result).toMatchObject({ outcome: "published", folded: 1, stop: "tick-budget" });
  });

  test("reset refuses a tenant with no saved head", async () => {
    await expect(resetTenant(bucketOver(new MemoryStorage()), "d1b256")).rejects.toThrow(
      /no saved fixture head/,
    );
  });
});
