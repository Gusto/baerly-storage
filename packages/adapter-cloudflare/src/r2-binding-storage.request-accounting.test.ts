/**
 * Characterization: binding calls `r2BindingStorage` issues behind ONE
 * outer `Storage` call. The adapter has no retry loop, so get / put /
 * delete are exactly one binding call each — success or failure. `list`
 * is one `bucket.list` per page, so an outer meter that counts one
 * `list` per call (`wrapCountingStorage`, `observableStorage`) undercounts
 * by the page count.
 *
 * Plain unit tests over a fake binding — runs in the default vitest
 * project, like `r2-binding-storage.test.ts`.
 */

import { type BaerlyError } from "@baerly/protocol";
import { describe, expect, test } from "vitest";
import { wrapCountingStorage } from "../../../tests/fixtures/counting-storage.ts";
import { r2BindingStorage } from "./r2-binding-storage.ts";

const NETWORK_ERROR = "NetworkError" as const;

interface FakePage {
  readonly keys: readonly string[];
  readonly truncated: boolean;
}

interface BindingCalls {
  get: number;
  put: number;
  delete: number;
  list: R2ListOptions[];
}

/**
 * A minimal `R2Bucket` counting every binding call. `list` replays
 * `pages` in order; `failing` makes get / put / delete reject with a
 * plain `Error` (mapped to `NetworkError` by the adapter).
 */
const mkBucket = (
  pages: readonly FakePage[] = [],
  failing = false,
): { bucket: R2Bucket; calls: BindingCalls } => {
  const calls: BindingCalls = { get: 0, put: 0, delete: 0, list: [] };
  const fail = () => Promise.reject(new Error("internal error"));
  const object = { key: "k", etag: "e", uploaded: new Date(0) };
  const bucket = {
    get: () => {
      calls.get++;
      return failing
        ? fail()
        : Promise.resolve({ ...object, body: {}, arrayBuffer: async () => new ArrayBuffer(1) });
    },
    put: () => {
      calls.put++;
      return failing ? fail() : Promise.resolve(object);
    },
    delete: () => {
      calls.delete++;
      return failing ? fail() : Promise.resolve();
    },
    list: (opts: R2ListOptions) => {
      calls.list.push(opts);
      const page = pages[calls.list.length - 1]!;
      return Promise.resolve({
        objects: page.keys.map((key) => ({ key, etag: "e" })),
        truncated: page.truncated,
        cursor: page.truncated ? `tok${calls.list.length}` : undefined,
      });
    },
  } as unknown as R2Bucket;
  return { bucket, calls };
};

const drain = async (iter: AsyncIterable<{ key: string }>): Promise<string[]> => {
  const out: string[] = [];
  for await (const e of iter) {
    out.push(e.key);
  }
  return out;
};

describe("r2BindingStorage request accounting", () => {
  test("get / put / delete succeed with exactly one binding call each", async () => {
    const { bucket, calls } = mkBucket();
    const counted = wrapCountingStorage(r2BindingStorage(bucket));
    await counted.storage.get("k");
    await counted.storage.put("k", new Uint8Array([1]), { ifNoneMatch: "*" });
    await counted.storage.delete("k");
    expect([counted.gets, counted.puts, counted.deletes]).toEqual([1, 1, 1]);
    expect([calls.get, calls.put, calls.delete]).toEqual([1, 1, 1]);
  });

  test("a failing get / put / delete is one binding call — no adapter retries", async () => {
    const { bucket, calls } = mkBucket([], true);
    const counted = wrapCountingStorage(r2BindingStorage(bucket));
    for (const op of [
      () => counted.storage.get("k"),
      () => counted.storage.put("k", new Uint8Array([1]), { ifNoneMatch: "*" }),
      () => counted.storage.delete("k"),
    ]) {
      const err = (await op().catch((error: unknown) => error)) as BaerlyError;
      expect(err.code).toBe(NETWORK_ERROR);
    }
    expect([counted.gets, counted.puts, counted.deletes]).toEqual([1, 1, 1]);
    expect([calls.get, calls.put, calls.delete]).toEqual([1, 1, 1]);
  });

  test("3 pages — outer meter sees 1 list, binding sees 3", async () => {
    const pages = [
      { keys: ["p/a"], truncated: true },
      { keys: ["p/b"], truncated: true },
      { keys: ["p/c"], truncated: false },
    ];
    const { bucket, calls } = mkBucket(pages);
    const counted = wrapCountingStorage(r2BindingStorage(bucket));
    await expect(drain(counted.storage.list("p/"))).resolves.toEqual(["p/a", "p/b", "p/c"]);
    expect(counted.lists).toBe(1);
    expect(calls.list).toHaveLength(pages.length);
  });

  test("an exactly-full truncated page at maxKeys stops without a follow-up call", async () => {
    const { bucket, calls } = mkBucket([{ keys: ["p/a", "p/b"], truncated: true }]);
    const counted = wrapCountingStorage(r2BindingStorage(bucket));
    await expect(drain(counted.storage.list("p/", { maxKeys: 2 }))).resolves.toEqual([
      "p/a",
      "p/b",
    ]);
    expect(counted.lists).toBe(1);
    expect(calls.list).toHaveLength(1);
  });

  test("an empty truncated page costs another call — outer 1 list, binding sees 3", async () => {
    const pages = [
      { keys: [], truncated: true },
      { keys: [], truncated: true },
      { keys: ["p/a"], truncated: false },
    ];
    const { bucket, calls } = mkBucket(pages);
    const counted = wrapCountingStorage(r2BindingStorage(bucket));
    await expect(
      drain(counted.storage.list("p/", { maxKeys: 5, startAfter: "p/" })),
    ).resolves.toEqual(["p/a"]);
    expect(counted.lists).toBe(1);
    expect(calls.list).toHaveLength(pages.length);
    expect(calls.list[1]?.cursor).toBe("tok1");
  });
});
