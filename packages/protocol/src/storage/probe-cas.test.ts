import { describe, expect, test } from "vitest";
import { BaerlyError } from "../errors.ts";
import { MemoryStorage } from "./memory.ts";
import { probeCas } from "./probe-cas.ts";
import type { Storage, StoragePutOptions, StoragePutResult } from "./types.ts";

describe("probeCas", () => {
  test("passes against a CAS-honouring backend (MemoryStorage)", async () => {
    const result = await probeCas(new MemoryStorage());
    expect(result.ok).toBe(true);
    expect(result.checks.map((c) => c.name).toSorted()).toEqual([
      "ifMatch-stale",
      "ifNoneMatch-concurrent",
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

  test("empty keyPrefix produces key under __baerly_cas_probe__/", async () => {
    // Kills the L51 StringLiteral → "" mutant: without a prefix the key
    // must still begin with the sentinel path segment.
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
    await probeCas(wrapped);
    expect(seen[0]).toMatch(/^__baerly_cas_probe__\//);
  });

  test("result.ok is true only when ALL checks pass (kills .every→.some mutant)", async () => {
    // A storage that fails exactly one check (ifMatch-stale) but passes the other
    // (ifNoneMatch-exists). result.ok must be false because .every requires all to pass.
    class OnlyIfNoneMatchStorage extends MemoryStorage {
      override async put(
        key: string,
        body: Uint8Array,
        opts?: StoragePutOptions,
      ): Promise<StoragePutResult> {
        // Let ifNoneMatch work normally (MemoryStorage handles it), but silently
        // ignore ifMatch — accept any stale write unconditionally.
        if (opts?.ifMatch !== undefined) {
          return super.put(key, body); // drop the condition → accepted
        }
        return super.put(key, body, opts);
      }
    }

    const result = await probeCas(new OnlyIfNoneMatchStorage());
    // ifMatch-stale should fail (backend accepted the stale write)
    expect(result.checks.find((c) => c.name === "ifMatch-stale")?.ok).toBe(false);
    // ifNoneMatch-exists should pass (backend correctly rejected)
    expect(result.checks.find((c) => c.name === "ifNoneMatch-exists")?.ok).toBe(true);
    // Aggregate must be false: ONE failure → overall not-ok (.every semantics)
    expect(result.ok).toBe(false);
  });

  test("result.ok is true only when ALL checks pass — ifNoneMatch half (kills .every→.some)", async () => {
    // Mirror: ifMatch works but ifNoneMatch is silently ignored.
    class OnlyIfMatchStorage extends MemoryStorage {
      override async put(
        key: string,
        body: Uint8Array,
        opts?: StoragePutOptions,
      ): Promise<StoragePutResult> {
        if (opts?.ifNoneMatch !== undefined) {
          return super.put(key, body); // silently accept create-on-existing
        }
        return super.put(key, body, opts);
      }
    }

    const result = await probeCas(new OnlyIfMatchStorage());
    expect(result.checks.find((c) => c.name === "ifMatch-stale")?.ok).toBe(true);
    expect(result.checks.find((c) => c.name === "ifNoneMatch-exists")?.ok).toBe(false);
    expect(result.ok).toBe(false);
  });

  test("check details for ifMatch-stale honored path contain expected substrings", async () => {
    // Kills L75 StringLiteral mutant: the ok:true detail must confirm correct rejection.
    const result = await probeCas(new MemoryStorage());
    const check = result.checks.find((c) => c.name === "ifMatch-stale");
    expect(check?.ok).toBe(true);
    expect(check?.detail).toContain("stale If-Match rejected");
    expect(check?.detail).toContain("Conflict");
  });

  test("check details for ifNoneMatch-exists honored path contain expected substrings", async () => {
    // Kills L100 StringLiteral mutant: the ok:true detail must confirm correct rejection.
    const result = await probeCas(new MemoryStorage());
    const check = result.checks.find((c) => c.name === "ifNoneMatch-exists");
    expect(check?.ok).toBe(true);
    expect(check?.detail).toContain("If-None-Match");
    expect(check?.detail).toContain("Conflict");
  });

  test("check detail for ifNoneMatch-exists ignored path contains expected substrings", async () => {
    // Kills L92 StringLiteral mutant: the failure detail must name the risk.
    class NoCasStorage extends MemoryStorage {
      override async put(
        key: string,
        body: Uint8Array,
        opts?: StoragePutOptions,
      ): Promise<StoragePutResult> {
        void opts;
        return super.put(key, body);
      }
    }

    const result = await probeCas(new NoCasStorage());
    const check = result.checks.find((c) => c.name === "ifNoneMatch-exists");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain("ignores If-None-Match");
  });

  test("non-Conflict error on ifMatch check is recorded as ok:false with message", async () => {
    // Covers L77-80 (NoCoverage path): when storage.put throws a non-Conflict error
    // for the stale-ifMatch write, the check must be recorded as failed with
    // the original error's message embedded in the detail.
    const boom = new BaerlyError("NetworkError", "upstream TCP timeout");
    class NetworkErrorStorage extends MemoryStorage {
      private callCount = 0;
      override async put(
        key: string,
        body: Uint8Array,
        opts?: StoragePutOptions,
      ): Promise<StoragePutResult> {
        this.callCount++;
        if (this.callCount === 1) {
          // First put: succeed so we have a key to probe against.
          return super.put(key, body, opts);
        }
        if (opts?.ifMatch !== undefined) {
          // Second put (ifMatch probe): throw a non-Conflict error.
          throw boom;
        }
        return super.put(key, body, opts);
      }
    }

    const result = await probeCas(new NetworkErrorStorage());
    const check = result.checks.find((c) => c.name === "ifMatch-stale");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain("non-Conflict error");
    expect(check?.detail).toContain("upstream TCP timeout");
  });

  test("non-Conflict error on ifNoneMatch check is recorded as ok:false with message", async () => {
    // Covers L102-105 (NoCoverage path): same shape for the ifNoneMatch probe.
    const boom = new BaerlyError("NetworkError", "timeout on ifNoneMatch write");
    class NetworkErrorOnNoneMatchStorage extends MemoryStorage {
      private callCount = 0;
      override async put(
        key: string,
        body: Uint8Array,
        opts?: StoragePutOptions,
      ): Promise<StoragePutResult> {
        this.callCount++;
        if (this.callCount === 1) {
          return super.put(key, body, opts); // initial put — succeed
        }
        if (opts?.ifMatch !== undefined) {
          // ifMatch probe: throw Conflict so check 1 passes
          throw new BaerlyError("Conflict", "stale");
        }
        if (opts?.ifNoneMatch !== undefined) {
          // ifNoneMatch probe: throw a non-Conflict error
          throw boom;
        }
        return super.put(key, body, opts);
      }
    }

    const result = await probeCas(new NetworkErrorOnNoneMatchStorage());
    const check = result.checks.find((c) => c.name === "ifNoneMatch-exists");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain("non-Conflict error");
    expect(check?.detail).toContain("timeout on ifNoneMatch write");
  });

  test("non-Error throwable message is stringified in the non-Conflict detail", async () => {
    // Kills the `error instanceof Error ? error.message : String(error)` branch:
    // throw a plain string to exercise the String(error) arm.
    class StringThrowStorage extends MemoryStorage {
      private callCount = 0;
      override async put(
        key: string,
        body: Uint8Array,
        opts?: StoragePutOptions,
      ): Promise<StoragePutResult> {
        this.callCount++;
        if (this.callCount === 1) {
          return super.put(key, body, opts);
        }
        if (opts?.ifMatch !== undefined) {
          throw "raw string error";
        }
        return super.put(key, body, opts);
      }
    }

    const result = await probeCas(new StringThrowStorage());
    const check = result.checks.find((c) => c.name === "ifMatch-stale");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain("raw string error");
  });

  test("passes AbortSignal to initial put and to delete", async () => {
    // Kills L58 ObjectLiteral/StringLiteral and L114 ConditionalExpression mutants:
    // with a signal, it must be forwarded; without one, delete must receive undefined.
    const controller = new AbortController();
    const storage = new MemoryStorage();
    const putCalls: Array<StoragePutOptions | undefined> = [];
    let deleteSigArg: { signal?: AbortSignal } | undefined = undefined;

    const wrapped: Storage = {
      put: (key, body, opts) => {
        putCalls.push(opts);
        return storage.put(key, body, opts);
      },
      delete: (key, opts) => {
        deleteSigArg = opts as { signal?: AbortSignal } | undefined;
        return storage.delete(key, opts);
      },
      get: storage.get.bind(storage),
      list: storage.list.bind(storage),
    };

    await probeCas(wrapped, { signal: controller.signal });

    // Initial put (callCount=0) must carry the signal.
    expect(putCalls[0]?.signal).toBe(controller.signal);
    // Delete call must carry the signal too.
    expect(deleteSigArg).toBeDefined();
    expect((deleteSigArg as unknown as { signal?: AbortSignal }).signal).toBe(controller.signal);
  });

  test("delete receives undefined opts when no signal provided", async () => {
    // Kills L114 ConditionalExpression → false mutant: without a signal the
    // delete call must pass undefined (not an empty { signal: undefined } object).
    const storage = new MemoryStorage();
    let deleteSigArg: unknown = "NOT_SET";

    const wrapped: Storage = {
      put: storage.put.bind(storage),
      delete: (key, opts) => {
        deleteSigArg = opts;
        return storage.delete(key, opts);
      },
      get: storage.get.bind(storage),
      list: storage.list.bind(storage),
    };

    await probeCas(wrapped);
    expect(deleteSigArg).toBeUndefined();
  });

  test("isConflict: BaerlyError with wrong code is NOT treated as Conflict", async () => {
    // Kills L6 LogicalOperator (||) mutant: a BaerlyError with code !== "Conflict"
    // must produce ok:false, not ok:true.
    const nonConflictBaerlyError = new BaerlyError("NetworkError", "wrong code");
    class WrongCodeStorage extends MemoryStorage {
      private callCount = 0;
      override async put(
        key: string,
        body: Uint8Array,
        opts?: StoragePutOptions,
      ): Promise<StoragePutResult> {
        this.callCount++;
        if (this.callCount === 1) {
          return super.put(key, body, opts);
        }
        if (opts?.ifMatch !== undefined) {
          throw nonConflictBaerlyError;
        }
        return super.put(key, body, opts);
      }
    }

    const result = await probeCas(new WrongCodeStorage());
    const check = result.checks.find((c) => c.name === "ifMatch-stale");
    // A BaerlyError with code "NetworkError" is NOT a Conflict → ok must be false
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain("non-Conflict error");
  });

  test("isConflict: non-BaerlyError is not treated as Conflict", async () => {
    // Kills L6 ConditionalExpression → true mutant: a plain Error is not a
    // BaerlyError and must not be treated as a valid Conflict rejection.
    const plainError = new Error("generic failure");
    class PlainErrorStorage extends MemoryStorage {
      private callCount = 0;
      override async put(
        key: string,
        body: Uint8Array,
        opts?: StoragePutOptions,
      ): Promise<StoragePutResult> {
        this.callCount++;
        if (this.callCount === 1) {
          return super.put(key, body, opts);
        }
        if (opts?.ifMatch !== undefined) {
          throw plainError;
        }
        return super.put(key, body, opts);
      }
    }

    const result = await probeCas(new PlainErrorStorage());
    const check = result.checks.find((c) => c.name === "ifMatch-stale");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain("generic failure");
  });

  test("put options carry ifMatch value (stale ETag string not empty)", async () => {
    // Kills L62 StringLiteral → "" mutants: the ifMatch value sent to storage
    // must be the non-empty stale-ETag sentinel, not an empty string.
    const storage = new MemoryStorage();
    const ifMatchValues: Array<string | undefined> = [];
    const ifNoneMatchValues: Array<string | undefined> = [];

    const wrapped: Storage = {
      put: (key, body, opts) => {
        if (opts?.ifMatch !== undefined) {
          ifMatchValues.push(opts.ifMatch);
        }
        if (opts?.ifNoneMatch !== undefined) {
          ifNoneMatchValues.push(opts.ifNoneMatch);
        }
        return storage.put(key, body, opts);
      },
      delete: storage.delete.bind(storage),
      get: storage.get.bind(storage),
      list: storage.list.bind(storage),
    };

    await probeCas(wrapped);
    // The stale ifMatch sentinel must be a non-empty string
    expect(ifMatchValues).toHaveLength(1);
    expect(ifMatchValues[0]).toBeTruthy();
    // The ifNoneMatch check must use "*" for both the sequential and concurrent sub-checks
    // (Check 2: 1 call; Check 3: 16 concurrent racer calls → 17 total)
    expect(ifNoneMatchValues.length).toBeGreaterThanOrEqual(1);
    expect(ifNoneMatchValues.every((v) => v === "*")).toBe(true);
  });

  test("check names are exactly ifMatch-stale, ifNoneMatch-exists, and ifNoneMatch-concurrent", async () => {
    // Kills any StringLiteral → "" mutant on check name fields.
    const result = await probeCas(new MemoryStorage());
    const names = result.checks.map((c) => c.name).toSorted();
    expect(names).toEqual(["ifMatch-stale", "ifNoneMatch-concurrent", "ifNoneMatch-exists"]);
    // Each name individually
    expect(result.checks.find((c) => c.name === "ifMatch-stale")).toBeDefined();
    expect(result.checks.find((c) => c.name === "ifNoneMatch-exists")).toBeDefined();
    expect(result.checks.find((c) => c.name === "ifNoneMatch-concurrent")).toBeDefined();
  });

  test("initial put uses correct body encoding (not empty)", async () => {
    // Kills L58 StringLiteral → "" mutant: initial put body must not be empty.
    const storage = new MemoryStorage();
    let firstPutKey: string | undefined;
    let firstPutBody: Uint8Array | undefined;

    const wrapped: Storage = {
      put: (key, body, opts) => {
        if (firstPutKey === undefined) {
          firstPutKey = key;
          firstPutBody = body;
        }
        return storage.put(key, body, opts);
      },
      delete: storage.delete.bind(storage),
      get: storage.get.bind(storage),
      list: storage.list.bind(storage),
    };

    await probeCas(wrapped);
    expect(firstPutBody).toBeDefined();
    expect(firstPutBody!.length).toBeGreaterThan(0);
  });

  test("cleans up sentinel even when a check throws a non-Conflict error", async () => {
    // Covers NoCoverage cleanup path: even when isConflict fails, finally must
    // still delete the key. Reuses NetworkErrorStorage shape.
    class NetworkErrorStorage extends MemoryStorage {
      private callCount = 0;
      override async put(
        key: string,
        body: Uint8Array,
        opts?: StoragePutOptions,
      ): Promise<StoragePutResult> {
        this.callCount++;
        if (this.callCount === 1) {
          return super.put(key, body, opts);
        }
        if (opts?.ifMatch !== undefined) {
          throw new BaerlyError("NetworkError", "upstream TCP timeout");
        }
        return super.put(key, body, opts);
      }
    }

    const storage = new NetworkErrorStorage();
    await probeCas(storage);
    // After probe, the sentinel must be gone
    const residue: string[] = [];
    for await (const e of storage.list("__baerly_cas_probe__/")) {
      residue.push(e.key);
    }
    expect(residue).toEqual([]);
  });

  test("delete failure does not mask the probe verdict", async () => {
    // Kills L114 ObjectLiteral → {} mutant: even if delete throws, the result
    // returned should reflect the check outcomes, not the delete failure.
    class DeleteThrowsStorage extends MemoryStorage {
      override async delete(): Promise<void> {
        throw new Error("delete failed");
      }
    }

    // Should not throw; result should reflect normal checks.
    const result = await probeCas(new DeleteThrowsStorage());
    expect(result.ok).toBe(true);
    expect(result.checks).toHaveLength(3);
  });
});

describe("probeCas — ifNoneMatch-concurrent", () => {
  test("passes against a backend with atomic create-if-absent (MemoryStorage)", async () => {
    const result = await probeCas(new MemoryStorage());
    const concurrent = result.checks.find((c) => c.name === "ifNoneMatch-concurrent");
    expect(concurrent).toBeDefined();
    expect(concurrent!.ok).toBe(true);
    expect(result.ok).toBe(true);
  });

  test("fails against a backend that ignores ifNoneMatch (admits many winners)", async () => {
    let n = 0;
    const lawless: Storage = {
      async put(
        _key: string,
        _body: Uint8Array,
        _opts?: StoragePutOptions,
      ): Promise<StoragePutResult> {
        n += 1;
        return { etag: `"${n}"` };
      },
      async get() {
        return null;
      },
      async delete() {},
      async *list() {},
    };
    const result = await probeCas(lawless);
    const concurrent = result.checks.find((c) => c.name === "ifNoneMatch-concurrent");
    expect(concurrent).toBeDefined();
    expect(concurrent!.ok).toBe(false);
    expect(result.ok).toBe(false);
  });

  test("a transient non-Conflict loser makes the race inconclusive", async () => {
    // Exactly one winner, but one racer hits a transient error (e.g. an
    // unmapped S3 409 / network blip). The exactly-one-winner invariant
    // held, so the check must not scream "backend NOT linearizable"; still,
    // the deploy-time probe must fail closed and ask for a clean retry.
    // Conditional puts in this fake run check-then-act with no intervening
    // await, so the burst is deterministic. ifNoneMatch:"*" calls: #1 is the
    // sentinel's Check 2 (over an existing key → Conflict); #2.. is the race
    // burst — inject the transient on the second race write.
    const exists = new Set<string>();
    let inmCalls = 0;
    const flaky: Storage = {
      async put(
        key: string,
        _body: Uint8Array,
        opts?: StoragePutOptions,
      ): Promise<StoragePutResult> {
        if (opts?.ifNoneMatch === "*") {
          inmCalls += 1;
          if (inmCalls === 3) {
            throw new BaerlyError("NetworkError", "transient blip mid-race");
          }
          if (exists.has(key)) {
            throw new BaerlyError("Conflict", "key exists");
          }
          exists.add(key);
          return { etag: '"w"' };
        }
        if (opts?.ifMatch !== undefined) {
          throw new BaerlyError("Conflict", "stale If-Match");
        }
        exists.add(key);
        return { etag: '"u"' };
      },
      async get() {
        return null;
      },
      async delete() {},
      async *list() {},
    };
    const result = await probeCas(flaky);
    const concurrent = result.checks.find((c) => c.name === "ifNoneMatch-concurrent");
    expect(concurrent).toBeDefined();
    expect(concurrent!.ok).toBe(false);
    expect(result.ok).toBe(false);
    expect(concurrent!.detail).toContain("inconclusive");
    expect(concurrent!.detail).toContain("retry");
    expect(concurrent!.detail).not.toContain("NOT linearizable");
  });
});
