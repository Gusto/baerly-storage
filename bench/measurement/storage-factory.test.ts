import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  BaerlyError,
  type Storage,
  type StorageListEntry,
  type StoragePutResult,
} from "@baerly/protocol";
import { afterAll, describe, expect, test } from "vitest";
import { asAttemptId, wrapJournaledStorage } from "./storage-journal.ts";
import {
  type StorageFactory,
  type StorageLease,
  createExactKeyCleanup,
  createLocalFsStorageFactory,
  createMemoryStorageFactory,
  isWithinCleanupAuthority,
  withStorageLease,
} from "./storage-factory.ts";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const roots: string[] = [];

afterAll(async () => {
  for (const root of roots) {
    await rm(root, { recursive: true, force: true });
  }
});

const makeParent = async (): Promise<string> => {
  const parent = await mkdtemp(join(tmpdir(), "baerly-lane-a-parent-"));
  roots.push(parent);
  return parent;
};

/** Minimal key-addressable storage whose DELETE can be scripted to fail. */
class DeletableStorage implements Storage {
  readonly objects = new Map<string, Uint8Array>();
  readonly calls: string[] = [];
  readonly failDeletes = new Set<string>();

  async get(key: string): Promise<{ body: Uint8Array; etag: string } | null> {
    this.calls.push(`get:${key}`);
    const body = this.objects.get(key);
    return body === undefined ? null : { body, etag: '"e"' };
  }

  async put(key: string, body: Uint8Array): Promise<StoragePutResult> {
    this.calls.push(`put:${key}`);
    this.objects.set(key, body);
    return { etag: '"e"' };
  }

  async delete(key: string): Promise<void> {
    this.calls.push(`delete:${key}`);
    if (this.failDeletes.has(key)) {
      throw new BaerlyError("NetworkError", `delete ${key} failed`);
    }
    this.objects.delete(key);
  }

  async *list(prefix: string): AsyncIterable<StorageListEntry> {
    this.calls.push(`list:${prefix}`);
    for (const key of [...this.objects.keys()].toSorted()) {
      if (key.startsWith(prefix)) {
        yield { key, etag: '"e"' };
      }
    }
  }
}

// ── REVISION 2: the authority guard, tested directly ─────────────────────────
describe("isWithinCleanupAuthority", () => {
  test("accepts a direct child carrying the prefix", () => {
    expect(
      isWithinCleanupAuthority({
        root: "/tmp/parent/baerly-measurement-abc123",
        parent: "/tmp/parent",
        prefix: "baerly-measurement-",
      }),
    ).toBe(true);
  });

  test("rejects a grandchild, so a nested path can never be swept", () => {
    expect(
      isWithinCleanupAuthority({
        root: "/tmp/parent/nested/baerly-measurement-abc",
        parent: "/tmp/parent",
        prefix: "baerly-measurement-",
      }),
    ).toBe(false);
  });

  test("rejects the parent itself", () => {
    expect(
      isWithinCleanupAuthority({
        root: "/tmp/parent",
        parent: "/tmp/parent",
        prefix: "baerly-measurement-",
      }),
    ).toBe(false);
  });

  test("rejects a sibling that does not carry the prefix", () => {
    expect(
      isWithinCleanupAuthority({
        root: "/tmp/parent/someone-elses-dir",
        parent: "/tmp/parent",
        prefix: "baerly-measurement-",
      }),
    ).toBe(false);
  });

  test("rejects a path outside the parent entirely", () => {
    expect(
      isWithinCleanupAuthority({
        root: "/etc/baerly-measurement-abc",
        parent: "/tmp/parent",
        prefix: "baerly-measurement-",
      }),
    ).toBe(false);
  });
});
// ─────────────────────────────────────────────────────────────────────────────

describe("memory factory", () => {
  test("issues a fresh instance and a unique namespace per create", async () => {
    const factory = createMemoryStorageFactory();
    const first = await factory.create({ attemptId: asAttemptId("a-1") });
    const second = await factory.create({ attemptId: asAttemptId("a-2") });
    expect(first.status).toBe("created");
    expect(second.status).toBe("created");
    if (first.status !== "created" || second.status !== "created") {
      throw new Error("expected both creates to succeed");
    }
    expect(first.lease.namespace_id).not.toBe(second.lease.namespace_id);
    expect(first.lease.storage).not.toBe(second.lease.storage);
    expect(first.lease.backend).toBe("memory");
    await first.lease.storage.put("shared", enc("one"));
    await expect(second.lease.storage.get("shared")).resolves.toBeNull();
  });

  test("cleanup is clean, idempotent, and flips lifecycle once", async () => {
    const factory = createMemoryStorageFactory();
    const created = await factory.create({ attemptId: asAttemptId("a-3") });
    if (created.status !== "created") {
      throw new Error("expected create to succeed");
    }
    const lease: StorageLease = created.lease;
    expect(lease.lifecycle()).toBe("active");
    expect(lease.cleanup_authority.kind).toBe("memory-instance");
    const report = await lease.cleanup();
    expect(report.status).toBe("clean");
    expect(report.failures).toEqual([]);
    expect(lease.lifecycle()).toBe("cleaned");
    await expect(lease.cleanup()).resolves.toBe(report);
  });
});

describe("local-fs factory", () => {
  test("issues distinct mkdtemp roots", async () => {
    const parent = await makeParent();
    const factory = createLocalFsStorageFactory({ temp_parent: parent });
    const first = await factory.create({ attemptId: asAttemptId("b-1") });
    const second = await factory.create({ attemptId: asAttemptId("b-2") });
    if (first.status !== "created" || second.status !== "created") {
      throw new Error("expected both creates to succeed");
    }
    expect(first.lease.namespace_id).not.toBe(second.lease.namespace_id);
    expect(dirname(first.lease.namespace_id)).toBe(parent);
    expect(basename(first.lease.namespace_id).startsWith("baerly-measurement-")).toBe(true);
    await first.lease.cleanup();
    await second.lease.cleanup();
  });

  test("cleanup removes its exact root and spares a sibling", async () => {
    const parent = await makeParent();
    const sentinel = join(parent, "sentinel");
    await mkdir(sentinel);
    const factory = createLocalFsStorageFactory({ temp_parent: parent });
    const created = await factory.create({ attemptId: asAttemptId("b-3") });
    if (created.status !== "created") {
      throw new Error("expected create to succeed");
    }
    await created.lease.storage.put("nested/doc", enc("payload"));
    const report = await created.lease.cleanup();
    expect(report.status).toBe("clean");
    expect(report.authority).toEqual({
      kind: "exact-directory",
      absolute_path: created.lease.namespace_id,
    });
    await expect(stat(created.lease.namespace_id)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(sentinel)).resolves.toBeDefined();
    await expect(stat(parent)).resolves.toBeDefined();
  });

  test("a provisioning error becomes a structured failure, not a rejection", async () => {
    const parent = await makeParent();
    const factory = createLocalFsStorageFactory({
      temp_parent: join(parent, "does", "not", "exist"),
    });
    const created = await factory.create({ attemptId: asAttemptId("b-4") });
    expect(created.status).toBe("failed");
    if (created.status !== "failed") {
      throw new Error("expected create to fail");
    }
    expect(created.failure).toMatchObject({
      stage: "provision",
      factory_id: factory.id,
      backend: "local-fs",
      code: "ENOENT",
    });
    expect(typeof created.failure.message).toBe("string");
    expect(typeof created.failure.name).toBe("string");
  });

  test("mkdtemp on macOS appends a mixed-case suffix, which the guard tolerates", async () => {
    // `mkdtemp` appends a base-58 mixed-case suffix on macOS. The guard checks
    // `basename().startsWith(prefix)`, never a lowercase comparison, so a
    // mixed-case suffix must not make cleanup refuse.
    const parent = await makeParent();
    const factory = createLocalFsStorageFactory({ temp_parent: parent });
    const created = await factory.create({ attemptId: asAttemptId("b-5") });
    if (created.status !== "created") {
      throw new Error("expected create to succeed");
    }
    const report = await created.lease.cleanup();
    expect(report.status).toBe("clean");
    expect(report.cleaned_targets).toEqual([created.lease.namespace_id]);
  });
});

describe("exact-key cleanup", () => {
  test("deletes only the named keys and never lists", async () => {
    const inner = new DeletableStorage();
    await inner.put("a/1", enc("1"));
    await inner.put("a/2", enc("2"));
    await inner.put("a/3", enc("3"));
    inner.calls.length = 0;
    const cleanup = createExactKeyCleanup({ storage: inner, keys: ["a/2", "a/1", "a/1"] });
    expect(cleanup.authority).toEqual({ kind: "exact-keys", keys: ["a/1", "a/2"] });
    const report = await cleanup.cleanup();
    expect(report.status).toBe("clean");
    expect(report.cleaned_targets).toEqual(["a/1", "a/2"]);
    expect(inner.calls).toEqual(["delete:a/1", "delete:a/2"]);
    expect([...inner.objects.keys()]).toEqual(["a/3"]);
  });

  test("one failing delete yields partial and still attempts later keys", async () => {
    const inner = new DeletableStorage();
    await inner.put("a/1", enc("1"));
    await inner.put("a/2", enc("2"));
    await inner.put("a/3", enc("3"));
    inner.failDeletes.add("a/2");
    inner.calls.length = 0;
    const cleanup = createExactKeyCleanup({ storage: inner, keys: ["a/1", "a/2", "a/3"] });
    const report = await cleanup.cleanup();
    expect(report.status).toBe("partial");
    expect(report.attempted_targets).toEqual(["a/1", "a/2", "a/3"]);
    expect(report.cleaned_targets).toEqual(["a/1", "a/3"]);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toMatchObject({ target: "a/2", code: "NetworkError" });
    expect(inner.calls).toEqual(["delete:a/1", "delete:a/2", "delete:a/3"]);
  });

  test("a repeat cleanup issues zero additional storage calls", async () => {
    const inner = new DeletableStorage();
    await inner.put("a/1", enc("1"));
    inner.calls.length = 0;
    const cleanup = createExactKeyCleanup({ storage: inner, keys: ["a/1"] });
    const first = await cleanup.cleanup();
    const callsAfterFirst = inner.calls.length;
    const second = await cleanup.cleanup();
    expect(second).toBe(first);
    expect(inner.calls).toHaveLength(callsAfterFirst);
  });
});

describe("withStorageLease", () => {
  /** Factory whose cleanup always fails, so cleanup outcome can be exercised. */
  const failingCleanupFactory = (inner: DeletableStorage): StorageFactory => ({
    id: "test.failing-cleanup/v1",
    backend: "test-failing",
    create: async ({ attemptId }) => {
      const journaled = wrapJournaledStorage({ attemptId, storage: inner });
      const cleanup = createExactKeyCleanup({ storage: inner, keys: ["boom"] });
      let lifecycle: "active" | "cleaned" = "active";
      let report: Awaited<ReturnType<typeof cleanup.cleanup>> | undefined;
      return {
        status: "created",
        lease: {
          attempt_id: attemptId,
          factory_id: "test.failing-cleanup/v1",
          backend: "test-failing",
          namespace_id: "test-failing-0",
          storage: journaled.storage,
          journal: journaled.journal,
          cleanup_authority: cleanup.authority,
          lifecycle: () => lifecycle,
          cleanup: async () => {
            lifecycle = "cleaned";
            report ??= await cleanup.cleanup();
            return report;
          },
        },
      };
    },
  });

  test("returns the work value plus the cleanup report", async () => {
    const factory = createMemoryStorageFactory();
    const outcome = await withStorageLease(factory, asAttemptId("c-1"), async (lease) => {
      await lease.storage.put("x", enc("y"));
      return lease.journal.snapshotOperations().length;
    });
    expect(outcome.status).toBe("returned");
    if (outcome.status !== "returned") {
      throw new Error("expected returned");
    }
    expect(outcome.value).toBe(1);
    expect(outcome.cleanup.status).toBe("clean");
    expect(outcome.pending_operations_at_cleanup).toBe(0);
  });

  test("surfaces a provisioning failure without running the work", async () => {
    const parent = await makeParent();
    const factory = createLocalFsStorageFactory({ temp_parent: join(parent, "absent") });
    let ran = false;
    const outcome = await withStorageLease(factory, asAttemptId("c-2"), async () => {
      ran = true;
      return 1;
    });
    expect(ran).toBe(false);
    expect(outcome.status).toBe("provision_failed");
  });

  test("preserves the thrown object by identity when cleanup also fails", async () => {
    const inner = new DeletableStorage();
    await inner.put("boom", enc("v"));
    inner.failDeletes.add("boom");
    const thrown = new BaerlyError("Internal", "work exploded");
    const outcome = await withStorageLease(
      failingCleanupFactory(inner),
      asAttemptId("c-3"),
      async () => {
        throw thrown;
      },
    );
    expect(outcome.status).toBe("threw");
    if (outcome.status !== "threw") {
      throw new Error("expected threw");
    }
    expect(outcome.error).toBe(thrown);
    expect(outcome.cleanup.status).toBe("failed");
    expect(outcome.cleanup.failures).toHaveLength(1);
  });

  test("marks the lease cleaned even when cleanup fails", async () => {
    const inner = new DeletableStorage();
    await inner.put("boom", enc("v"));
    inner.failDeletes.add("boom");
    const created = await failingCleanupFactory(inner).create({ attemptId: asAttemptId("c-4") });
    if (created.status !== "created") {
      throw new Error("expected create to succeed");
    }
    expect(created.lease.lifecycle()).toBe("active");
    const report = await created.lease.cleanup();
    expect(report.status).toBe("failed");
    expect(created.lease.lifecycle()).toBe("cleaned");
  });

  // ── REVISION 2: non-quiescence is reported, not hidden and not thrown ─────
  test("reports in-flight operations at cleanup instead of silently tearing down", async () => {
    const factory = createMemoryStorageFactory();
    let leaked: Promise<unknown> | undefined;
    const outcome = await withStorageLease(factory, asAttemptId("c-5"), async (lease) => {
      // Deliberately abandon an operation: the work function returns without
      // awaiting it, so the lease's storage is about to be torn out from under
      // an in-flight call. That must be VISIBLE in the result.
      leaked = lease.storage.put("abandoned", enc("v"));
      return "done";
    });
    expect(outcome.status).toBe("returned");
    if (outcome.status !== "returned") {
      throw new Error("expected returned");
    }
    expect(outcome.pending_operations_at_cleanup).toBeGreaterThan(0);
    await leaked;
  });

  test("does not let a non-quiescent journal mask the work's own error", async () => {
    const factory = createMemoryStorageFactory();
    const thrown = new BaerlyError("Internal", "work exploded");
    let leaked: Promise<unknown> | undefined;
    const outcome = await withStorageLease(factory, asAttemptId("c-6"), async (lease) => {
      leaked = lease.storage.put("abandoned", enc("v"));
      throw thrown;
    });
    expect(outcome.status).toBe("threw");
    if (outcome.status !== "threw") {
      throw new Error("expected threw");
    }
    expect(outcome.error).toBe(thrown);
    await leaked;
  });
  // ──────────────────────────────────────────────────────────────────────────
});
