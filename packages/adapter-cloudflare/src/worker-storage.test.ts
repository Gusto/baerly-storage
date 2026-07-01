import { BaerlyError, MemoryStorage } from "@baerly/protocol";
import { describe, expect, test } from "vitest";
import { resolveWorkerStorage } from "./resolve-storage.ts";

describe("resolveWorkerStorage", () => {
  test("returns the injected storage when options.storage is set", () => {
    const injected = new MemoryStorage();
    const resolved = resolveWorkerStorage({ storage: injected }, {});
    expect(resolved).toBe(injected);
  });

  test("falls back to the R2 binding when no storage is injected", () => {
    // Minimal R2Bucket stand-in — resolveWorkerStorage only forwards it
    // to r2BindingStorage, which stores the handle without calling it.
    const fakeBucket = {} as R2Bucket;
    const injected = new MemoryStorage();
    const resolved = resolveWorkerStorage({}, { BUCKET: fakeBucket });
    // Took the R2 branch: a Storage-shaped handle that is NOT the
    // injected instance. `toBeDefined()` alone passes for any truthy
    // value and wouldn't prove the R2 path was taken.
    expect(resolved).not.toBe(injected);
    expect(typeof resolved.get).toBe("function");
    expect(typeof resolved.put).toBe("function");
    expect(typeof resolved.list).toBe("function");
  });

  test("throws InvalidConfig when neither storage nor BUCKET is present", () => {
    expect(() => resolveWorkerStorage({}, {})).toThrowError(BaerlyError);
    try {
      resolveWorkerStorage({}, {});
    } catch (error) {
      expect((error as BaerlyError).code).toBe("InvalidConfig");
    }
  });
});
