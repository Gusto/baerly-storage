import { BaerlyError, MemoryStorage, type Storage } from "@baerly/protocol";
import { describe, expect, test } from "vitest";
import { createObservabilityContext, runWithContext } from "./context.ts";
import { observableStorage } from "./storage.ts";

const collectAll = async (iter: AsyncIterable<{ key: string }>): Promise<string[]> => {
  const keys: string[] = [];
  for await (const e of iter) {
    keys.push(e.key);
  }
  return keys;
};

describe("observableStorage", () => {
  test("round-trips put/get/delete through the wrapper", async () => {
    const inner = new MemoryStorage();
    const wrapped = observableStorage(inner);

    const body = new TextEncoder().encode("hello");
    await wrapped.put("k", body);
    const got = await wrapped.get("k");
    expect(got?.body).toEqual(body);

    await wrapped.delete("k");
    await expect(wrapped.get("k")).resolves.toBeNull();
  });

  test("records duration histogram + calls_total + class-A counter for put", async () => {
    const inner = new MemoryStorage();
    const wrapped = observableStorage(inner);
    const ctx = createObservabilityContext();

    await runWithContext(ctx, async () => {
      await wrapped.put("k", new Uint8Array([1, 2, 3]));
    });

    const snap = ctx.recorder.snapshot();
    expect(snap.counters.some((c) => c.name === "db.storage.put.calls_total")).toBe(true);
    expect(snap.counters.some((c) => c.name === "db.storage.class_a_ops_total")).toBe(true);
    expect(snap.histograms.some((h) => h.name === "db.storage.put.duration_ms")).toBe(true);
  });

  test("records class-B counter for get", async () => {
    const inner = new MemoryStorage();
    const wrapped = observableStorage(inner);
    const ctx = createObservabilityContext();
    await runWithContext(ctx, async () => {
      await wrapped.get("missing");
    });

    const snap = ctx.recorder.snapshot();
    expect(snap.counters.some((c) => c.name === "db.storage.get.calls_total")).toBe(true);
    expect(snap.counters.some((c) => c.name === "db.storage.class_b_ops_total")).toBe(true);
    expect(snap.counters.some((c) => c.name === "db.storage.class_a_ops_total")).toBe(false);
  });

  test("records class-A counter for delete and list", async () => {
    const inner = new MemoryStorage();
    const wrapped = observableStorage(inner);
    const ctx = createObservabilityContext();
    await runWithContext(ctx, async () => {
      await wrapped.delete("any");
      await collectAll(wrapped.list("prefix"));
    });

    const snap = ctx.recorder.snapshot();
    const aCount = snap.counters.filter((c) => c.name === "db.storage.class_a_ops_total").length;
    expect(aCount).toBe(2);
  });

  test("error path rethrows and records the error counter", async () => {
    const exploding: Storage = {
      get: async () => {
        throw new BaerlyError("NetworkError", "down");
      },
      put: async () => ({ etag: "x" }),
      delete: async () => undefined,
      // eslint-disable-next-line require-yield -- never yields; throws on iteration
      list: async function* () {
        throw new BaerlyError("NetworkError", "down");
      },
    };
    const wrapped = observableStorage(exploding);
    const ctx = createObservabilityContext();

    await runWithContext(ctx, async () => {
      await expect(wrapped.get("k")).rejects.toBeInstanceOf(BaerlyError);
    });
    const snap = ctx.recorder.snapshot();
    expect(snap.counters.some((c) => c.name === "db.storage.get.errors_total")).toBe(true);
    expect(snap.histograms.some((h) => h.name === "db.storage.get.duration_ms")).toBe(true);
  });

  test("list error path rethrows mid-iteration and records error counter", async () => {
    const exploding: Storage = {
      get: async () => null,
      put: async () => ({ etag: "x" }),
      delete: async () => undefined,
      // eslint-disable-next-line require-yield -- never yields; throws on iteration
      list: async function* () {
        throw new BaerlyError("NetworkError", "down");
      },
    };
    const wrapped = observableStorage(exploding);
    const ctx = createObservabilityContext();

    await runWithContext(ctx, async () => {
      await expect(collectAll(wrapped.list("p"))).rejects.toBeInstanceOf(BaerlyError);
    });
    const snap = ctx.recorder.snapshot();
    expect(snap.counters.some((c) => c.name === "db.storage.list.errors_total")).toBe(true);
  });

  test("preserves AsyncIterable list semantics over MemoryStorage", async () => {
    const inner = new MemoryStorage();
    await inner.put("a/1", new Uint8Array([1]));
    await inner.put("a/2", new Uint8Array([2]));
    await inner.put("b/1", new Uint8Array([3]));
    const wrapped = observableStorage(inner);

    const keys = await collectAll(wrapped.list("a/"));
    expect(keys.toSorted()).toEqual(["a/1", "a/2"]);
  });

  test("outside any context, emissions are a no-op (no throw)", async () => {
    const inner = new MemoryStorage();
    const wrapped = observableStorage(inner);
    await wrapped.put("k", new Uint8Array([1]));
    const got = await wrapped.get("k");
    expect(got?.body).toEqual(new Uint8Array([1]));
  });
});
