import { describe, expect, test } from "vitest";
import { MemoryStorage } from "./memory.ts";
import { probeCas } from "./probe-cas.ts";
import type { Storage, StoragePutOptions, StoragePutResult } from "./types.ts";

describe("probeCas", () => {
  test("passes against a CAS-honouring backend (MemoryStorage)", async () => {
    const result = await probeCas(new MemoryStorage());
    expect(result.ok).toBe(true);
    expect(result.checks.map((c) => c.name).toSorted()).toEqual([
      "ifMatch-stale",
      "ifNoneMatch-exists",
    ]);
    expect(result.checks.every((c) => c.ok)).toBe(true);
  });

  test("cleans up its sentinel key (no residue on success)", async () => {
    const storage = new MemoryStorage();
    await probeCas(storage);
    const residue: string[] = [];
    for await (const e of storage.list("__baerly_cas_probe__/")) {
      residue.push(e.key);
    }
    expect(residue).toEqual([]);
  });

  test("FAILS LOUD on a backend that silently ignores If-Match / If-None-Match", async () => {
    // A non-conformant store: `put` always succeeds, ignoring the
    // conditional options entirely (the exact silent-corruption shape).
    class NoCasStorage extends MemoryStorage {
      override async put(
        key: string,
        body: Uint8Array,
        opts?: StoragePutOptions,
      ): Promise<StoragePutResult> {
        // Drop the conditions — accept every write unconditionally.
        void opts;
        return super.put(key, body);
      }
    }

    const result = await probeCas(new NoCasStorage());
    expect(result.ok).toBe(false);
    // Both conditional checks must report failure.
    expect(result.checks.find((c) => c.name === "ifMatch-stale")?.ok).toBe(false);
    expect(result.checks.find((c) => c.name === "ifNoneMatch-exists")?.ok).toBe(false);
    // The detail must name the risk loudly.
    expect(result.checks.find((c) => c.name === "ifMatch-stale")?.detail).toContain(
      "ignores If-Match",
    );
  });

  test("honours keyPrefix for the sentinel", async () => {
    const storage = new MemoryStorage();
    const seen: string[] = [];
    const wrapped: Storage = new Proxy(storage, {
      get(target, prop, receiver) {
        if (prop === "put") {
          return (key: string, body: Uint8Array, opts?: StoragePutOptions) => {
            seen.push(key);
            return target.put(key, body, opts);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    await probeCas(wrapped, { keyPrefix: "tenant-x/" });
    expect(seen.every((k) => k.startsWith("tenant-x/__baerly_cas_probe__/"))).toBe(true);
  });
});
