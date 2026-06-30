import {
  BaerlyError,
  MemoryStorage,
  type Storage,
  type StorageGetResult,
  type StorageListEntry,
  type StoragePutResult,
} from "@baerly/protocol";
import { describe, expect, test } from "vitest";
import { assertStorageReachable } from "./assert-storage-reachable.ts";

// A backend that ACCEPTS every write regardless of If-Match / If-None-Match
// — i.e. silently ignores the conditionals the protocol depends on. probeCas
// must catch this; assertStorageReachable must turn it into a thrown error.
const conditionalsIgnoredStorage = (): Storage => ({
  async get(): Promise<StorageGetResult | null> {
    return null;
  },
  async put(): Promise<StoragePutResult> {
    return { etag: '"ignored"' };
  },
  async delete(): Promise<void> {},
  async *list(): AsyncIterable<StorageListEntry> {},
});

// A backend whose every operation throws — stands in for a wrong/unreachable
// bucket or denied credentials.
const unreachableStorage = (): Storage => ({
  async get(): Promise<StorageGetResult | null> {
    throw new Error("getaddrinfo ENOTFOUND wrong-bucket.example");
  },
  async put(): Promise<StoragePutResult> {
    throw new Error("getaddrinfo ENOTFOUND wrong-bucket.example");
  },
  async delete(): Promise<void> {
    throw new Error("getaddrinfo ENOTFOUND wrong-bucket.example");
  },
  list(): AsyncIterable<StorageListEntry> {
    throw new Error("getaddrinfo ENOTFOUND wrong-bucket.example");
  },
});

describe("assertStorageReachable", () => {
  test("resolves for a CAS-correct, reachable backend", async () => {
    await expect(assertStorageReachable(new MemoryStorage())).resolves.toBeUndefined();
  });

  test("throws InvalidConfig when the backend ignores conditional writes", async () => {
    const err = await assertStorageReachable(conditionalsIgnoredStorage()).catch(
      (error: unknown) => error,
    );
    expect(err).toBeInstanceOf(BaerlyError);
    expect((err as BaerlyError).code).toBe("InvalidConfig");
    // The thrown message names the failing CAS checks so an operator can act.
    expect((err as BaerlyError).message).toContain("conditional writes");
    expect((err as BaerlyError).message).toMatch(/ifMatch-stale|ifNoneMatch-exists/);
  });

  test("throws NetworkError when the backend is unreachable", async () => {
    const err = await assertStorageReachable(unreachableStorage()).catch((error: unknown) => error);
    expect(err).toBeInstanceOf(BaerlyError);
    expect((err as BaerlyError).code).toBe("NetworkError");
    expect((err as BaerlyError).message).toContain("could not be reached");
    // Original cause is preserved for diagnostics.
    expect((err as BaerlyError).cause).toBeInstanceOf(Error);
  });
});
