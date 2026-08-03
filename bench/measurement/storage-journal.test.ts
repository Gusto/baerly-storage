/* eslint-disable no-underscore-dangle -- `_entry` marks a deliberately unused
   loop binding where the test only needs the iterable DRAINED (or broken out
   of) and not the yielded value. Same convention, and same file-level opt-out,
   as `tests/integration/maintenance-e2e.test.ts`. */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  BaerlyError,
  type Storage,
  type StorageGetOptions,
  type StorageGetResult,
  type StorageListEntry,
  type StoragePutOptions,
  type StoragePutResult,
} from "@baerly/protocol";
import { describe, expect, test, vi } from "vitest";
import {
  InvalidAttemptIdError,
  JournalNotQuiescentError,
  NAMESPACE_JOURNAL_VERSION,
  OPERATION_JOURNAL_VERSION,
  asAttemptId,
  billingClassOf,
  classifyStorageError,
  wrapJournaledStorage,
} from "./storage-journal.ts";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/**
 * Clock-free scriptable backend. `MemoryStorage` cannot be used for the
 * zero-clock-read assertion below because its `put` returns
 * `serverDate: new Date()` — a real wall-clock read on every write.
 */
class StubStorage implements Storage {
  readonly objects = new Map<string, { body: Uint8Array; etag: string }>();
  readonly calls: string[] = [];
  readonly completions: string[] = [];
  readonly getTicks = new Map<string, number>();
  readonly failOn = new Map<string, unknown>();
  /** Resolve manually to hold an operation in flight. */
  readonly gates = new Map<string, () => void>();
  #etag = 0;

  async get(key: string, _opts?: StorageGetOptions): Promise<StorageGetResult | null> {
    this.calls.push(`get:${key}`);
    const ticks = this.getTicks.get(key) ?? 0;
    for (let i = 0; i < ticks; i++) {
      await Promise.resolve();
    }
    if (this.gates.has(`get:${key}`)) {
      await new Promise<void>((resolve) => this.gates.set(`get:${key}`, resolve));
    }
    this.completions.push(`get:${key}`);
    const failure = this.failOn.get(`get:${key}`);
    if (failure !== undefined) {
      throw failure;
    }
    const stored = this.objects.get(key);
    return stored === undefined ? null : { body: stored.body, etag: stored.etag };
  }

  async put(key: string, body: Uint8Array, _opts?: StoragePutOptions): Promise<StoragePutResult> {
    this.calls.push(`put:${key}`);
    const failure = this.failOn.get(`put:${key}`);
    if (failure !== undefined) {
      throw failure;
    }
    this.#etag += 1;
    const etag = `"${this.#etag}"`;
    this.objects.set(key, { body, etag });
    return { etag };
  }

  async delete(key: string, _opts?: { signal?: AbortSignal }): Promise<void> {
    this.calls.push(`delete:${key}`);
    const failure = this.failOn.get(`delete:${key}`);
    if (failure !== undefined) {
      throw failure;
    }
    this.objects.delete(key);
  }

  async *list(
    prefix: string,
    _opts?: { startAfter?: string; maxKeys?: number; signal?: AbortSignal },
  ): AsyncIterable<StorageListEntry> {
    this.calls.push(`list:${prefix}`);
    const failure = this.failOn.get(`list:${prefix}`);
    if (failure !== undefined) {
      throw failure;
    }
    for (const [key, stored] of [...this.objects].toSorted((a, b) => (a[0] < b[0] ? -1 : 1))) {
      if (key.startsWith(prefix)) {
        yield { key, etag: stored.etag };
      }
    }
  }
}

const abortedError = (): unknown => {
  const controller = new AbortController();
  controller.abort();
  try {
    controller.signal.throwIfAborted();
  } catch (error: unknown) {
    return error;
  }
  throw new Error("unreachable: throwIfAborted did not throw");
};

describe("attempt identity", () => {
  test("accepts a conventional id and brands it", () => {
    expect(asAttemptId("attempt-1")).toBe("attempt-1");
    expect(asAttemptId("study.fold:cell_07")).toBe("study.fold:cell_07");
  });

  test("rejects ids that would be unsafe as a filename or JSON key", () => {
    for (const bad of ["", " ", "a b", "a/b", "a\\b", "a\nb", "x".repeat(129), "é"]) {
      expect(() => asAttemptId(bad)).toThrow(InvalidAttemptIdError);
    }
  });

  test("the thrown error carries the offending value", () => {
    try {
      asAttemptId("a/b");
      throw new Error("expected a throw");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(InvalidAttemptIdError);
      expect((error as InvalidAttemptIdError).value).toBe("a/b");
    }
  });
});

describe("operation journal", () => {
  test("records method, key, and dispatch-ordered indices", async () => {
    const stub = new StubStorage();
    const { storage, journal } = wrapJournaledStorage({
      attemptId: asAttemptId("attempt-1"),
      storage: stub,
    });
    await storage.put("a/1", enc("abc"));
    await storage.get("a/1");
    await storage.delete("a/1");
    for await (const _entry of storage.list("a/")) {
      /* drain */
    }
    const ops = journal.snapshotOperations();
    expect(ops.map((o) => o.method)).toEqual(["put", "get", "delete", "list"]);
    expect(ops.map((o) => o.operation_index)).toEqual([0, 1, 2, 3]);
    expect(ops.every((o) => o.schema === OPERATION_JOURNAL_VERSION)).toBe(true);
    expect(ops.every((o) => o.attempt_id === "attempt-1")).toBe(true);
    expect(journal.pendingOperationCount()).toBe(0);
  });

  test("indices follow dispatch even when GETs settle in reverse", async () => {
    const stub = new StubStorage();
    stub.objects.set("k/1", { body: enc("one"), etag: '"e1"' });
    stub.objects.set("k/2", { body: enc("two"), etag: '"e2"' });
    stub.getTicks.set("k/1", 20);
    const { storage, journal } = wrapJournaledStorage({
      attemptId: asAttemptId("attempt-2"),
      storage: stub,
    });
    const first = storage.get("k/1");
    const second = storage.get("k/2");
    await Promise.all([first, second]);
    expect(stub.completions).toEqual(["get:k/2", "get:k/1"]);
    const ops = journal.snapshotOperations();
    expect(ops.map((o) => o.key)).toEqual(["k/1", "k/2"]);
    expect(ops.map((o) => o.operation_index)).toEqual([0, 1]);
  });

  // ── REVISION 2: quiescence is enforced, not advertised ────────────────────
  test("snapshotOperations THROWS while an operation is in flight", async () => {
    const stub = new StubStorage();
    stub.gates.set("get:slow", () => {});
    const { storage, journal } = wrapJournaledStorage({
      attemptId: asAttemptId("attempt-q1"),
      storage: stub,
    });
    const inflight = storage.get("slow");
    await Promise.resolve();
    expect(journal.pendingOperationCount()).toBe(1);
    expect(() => journal.snapshotOperations()).toThrow(JournalNotQuiescentError);
    // The settled-only view is the explicit opt-out and never throws.
    expect(journal.snapshotSettledOperations()).toEqual([]);
    expect(journal.pendingOperations()).toEqual([
      { operation_index: 0, method: "get", key: "slow" },
    ]);
    stub.gates.get("get:slow")?.();
    await inflight;
    expect(journal.snapshotOperations()).toHaveLength(1);
  });

  test("the quiescence error names every pending row", async () => {
    const stub = new StubStorage();
    stub.gates.set("get:a", () => {});
    stub.gates.set("get:b", () => {});
    const { storage, journal } = wrapJournaledStorage({
      attemptId: asAttemptId("attempt-q2"),
      storage: stub,
    });
    const a = storage.get("a");
    const b = storage.get("b");
    await Promise.resolve();
    try {
      journal.snapshotOperations();
      throw new Error("expected a throw");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(JournalNotQuiescentError);
      expect((error as JournalNotQuiescentError).pending.map((p) => p.key)).toEqual(["a", "b"]);
    }
    stub.gates.get("get:a")?.();
    stub.gates.get("get:b")?.();
    await Promise.all([a, b]);
  });
  // ──────────────────────────────────────────────────────────────────────────

  test("records PUT byte length and the SHA-256 of the exact bytes", async () => {
    const stub = new StubStorage();
    const { storage, journal } = wrapJournaledStorage({
      attemptId: asAttemptId("attempt-3"),
      storage: stub,
    });
    await storage.put("d", enc("abc"));
    const [op] = journal.snapshotOperations();
    expect(op?.put).toEqual({
      byte_length: 3,
      sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    });
  });

  test("digests the bytes as of dispatch, not as of later mutation", async () => {
    const stub = new StubStorage();
    const { storage, journal } = wrapJournaledStorage({
      attemptId: asAttemptId("attempt-4"),
      storage: stub,
    });
    const body = enc("abc");
    const inflight = storage.put("d", body);
    body[0] = 0x7a;
    await inflight;
    const [op] = journal.snapshotOperations();
    expect(op?.put?.sha256).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  test("passes the ORIGINAL array to the inner storage, not the digest copy", async () => {
    const stub = new StubStorage();
    const { storage } = wrapJournaledStorage({
      attemptId: asAttemptId("attempt-4b"),
      storage: stub,
    });
    const body = enc("abc");
    await storage.put("d", body);
    // MemoryStorage-shaped backends retain the caller's array by reference;
    // substituting the copy would change what the system under test observes.
    expect(stub.objects.get("d")?.body).toBe(body);
  });

  test("captures only the options that were supplied", async () => {
    const stub = new StubStorage();
    stub.objects.set("o", { body: enc("x"), etag: '"e"' });
    const live = new AbortController();
    const dead = new AbortController();
    dead.abort();
    const signalIds = new Map<AbortSignal, string>([
      [live.signal, "writer-signal"],
      [dead.signal, "cancelled-signal"],
    ]);
    const { storage, journal } = wrapJournaledStorage({
      attemptId: asAttemptId("attempt-5"),
      storage: stub,
      signalIds,
    });
    await storage.get("o");
    await storage.put("o", enc("y"), { ifMatch: '"e"', contentType: "application/json" });
    await storage.put("o2", enc("y"), { ifNoneMatch: "*" });
    await storage.get("o", { versionId: "v7", signal: live.signal });
    await storage.get("o", { ifNoneMatch: '"e"', signal: dead.signal });
    for await (const _entry of storage.list("o", { startAfter: "o", maxKeys: 5 })) {
      /* drain */
    }
    const ops = journal.snapshotOperations();
    expect(Object.keys(ops[0]?.options ?? { missing: true })).toEqual([]);
    expect(ops[1]?.options).toEqual({ if_match: '"e"', content_type: "application/json" });
    expect(ops[2]?.options).toEqual({ if_none_match: "*" });
    expect(ops[3]?.options).toEqual({
      version_id: "v7",
      signal: { id: "writer-signal", present: true, aborted_at_dispatch: false },
    });
    expect(ops[4]?.options).toEqual({
      if_none_match: '"e"',
      signal: { id: "cancelled-signal", present: true, aborted_at_dispatch: true },
    });
    expect(ops[5]?.options).toEqual({ start_after: "o", max_keys: 5 });
  });

  test("names an unnamed signal deterministically and stably", async () => {
    const stub = new StubStorage();
    const first = new AbortController();
    const second = new AbortController();
    const { storage, journal } = wrapJournaledStorage({
      attemptId: asAttemptId("attempt-5b"),
      storage: stub,
    });
    await storage.get("a", { signal: first.signal });
    await storage.get("b", { signal: second.signal });
    await storage.get("c", { signal: first.signal });
    const ids = journal.snapshotOperations().map((o) => o.options.signal?.id);
    expect(ids).toEqual(["signal-1", "signal-2", "signal-1"]);
  });

  test("classifies returned results", async () => {
    const stub = new StubStorage();
    const { storage, journal } = wrapJournaledStorage({
      attemptId: asAttemptId("attempt-6"),
      storage: stub,
    });
    await storage.get("absent");
    await storage.put("p", enc("v"));
    await storage.get("p");
    await storage.delete("p");
    for await (const _entry of storage.list("")) {
      /* drain */
    }
    const ops = journal.snapshotOperations();
    expect(ops.map((o) => o.result.classification)).toEqual([
      "not_found",
      "put_ok",
      "found",
      "delete_ok",
      "list_ok",
    ]);
    expect(ops[2]?.result).toMatchObject({ status: "returned", etag: '"1"' });
    expect(ops[4]?.result).toMatchObject({ status: "returned", listed_entries: 0 });
  });

  test("classifies every error class and rethrows the same object", async () => {
    const cases: readonly { readonly thrown: unknown; readonly expected: string }[] = [
      { thrown: abortedError(), expected: "aborted" },
      { thrown: new BaerlyError("Conflict", "precondition failed"), expected: "conflict" },
      { thrown: new BaerlyError("NetworkError", "503"), expected: "network_error" },
      { thrown: new BaerlyError("InvalidResponse", "bad xml"), expected: "invalid_response" },
      { thrown: new BaerlyError("Internal", "bug"), expected: "internal" },
      { thrown: new BaerlyError("InvalidConfig", "no bucket"), expected: "invalid_config" },
      { thrown: new Error("boom"), expected: "unknown" },
    ];
    for (const [index, entry] of cases.entries()) {
      const stub = new StubStorage();
      const key = `e${index}`;
      stub.failOn.set(`put:${key}`, entry.thrown);
      const { storage, journal } = wrapJournaledStorage({
        attemptId: asAttemptId(`attempt-err-${index}`),
        storage: stub,
      });
      let caught: unknown;
      try {
        await storage.put(key, enc("v"));
      } catch (error: unknown) {
        caught = error;
      }
      expect(caught).toBe(entry.thrown);
      const [op] = journal.snapshotOperations();
      expect(op?.result.status).toBe("threw");
      expect(op?.result.classification).toBe(entry.expected);
      expect(classifyStorageError(entry.thrown)).toBe(entry.expected);
    }
  });

  test("never writes a numeric DOMException code into the string code field", async () => {
    const stub = new StubStorage();
    stub.failOn.set("get:x", abortedError());
    const { storage, journal } = wrapJournaledStorage({
      attemptId: asAttemptId("attempt-dom"),
      storage: stub,
    });
    await expect(storage.get("x")).rejects.toThrow("aborted");
    const result = journal.snapshotOperations()[0]?.result;
    if (result === undefined || result.status !== "threw") {
      throw new Error("expected a threw result");
    }
    expect(result.classification).toBe("aborted");
    expect(result.name).toBe("AbortError");
    expect(result.code).toBeUndefined();
  });

  test("allocates the LIST index at iteration start and counts yielded entries", async () => {
    const stub = new StubStorage();
    stub.objects.set("l/1", { body: enc("1"), etag: '"1"' });
    stub.objects.set("l/2", { body: enc("2"), etag: '"2"' });
    const { storage, journal } = wrapJournaledStorage({
      attemptId: asAttemptId("attempt-7"),
      storage: stub,
    });
    const iterable = storage.list("l/");
    expect(journal.snapshotOperations()).toEqual([]);
    expect(stub.calls).toEqual([]);
    let seen = 0;
    for await (const _entry of iterable) {
      seen += 1;
    }
    expect(seen).toBe(2);
    const [op] = journal.snapshotOperations();
    expect(op?.result).toMatchObject({ classification: "list_ok", listed_entries: 2 });
  });

  // ── REVISION 2: the list-index hazard, pinned rather than hidden ──────────
  test("a LIST created early but iterated late sorts on the ITERATION clock", async () => {
    const stub = new StubStorage();
    stub.objects.set("l/1", { body: enc("1"), etag: '"1"' });
    const { storage, journal } = wrapJournaledStorage({
      attemptId: asAttemptId("attempt-7b"),
      storage: stub,
    });
    const deferred = storage.list("l/"); // created FIRST
    await storage.get("later"); // dispatched second
    for await (const _entry of deferred) {
      /* drain */
    }
    const ops = journal.snapshotOperations();
    // The GET, dispatched after `.list()` was CALLED, carries the LOWER index.
    // This is the parent plan's "allocate when iteration begins" rule, and it
    // means `list` is not on the same clock as the other three verbs. Any
    // downstream journal comparator must avoid separating `.list()` from its
    // iteration, or normalize. See Semantics §2 and Open question 6.
    expect(ops.map((o) => `${o.method}:${o.operation_index}`)).toEqual(["get:0", "list:1"]);
  });
  // ──────────────────────────────────────────────────────────────────────────

  test("settles a broken-out LIST with the partial count", async () => {
    const stub = new StubStorage();
    stub.objects.set("l/1", { body: enc("1"), etag: '"1"' });
    stub.objects.set("l/2", { body: enc("2"), etag: '"2"' });
    const { storage, journal } = wrapJournaledStorage({
      attemptId: asAttemptId("attempt-8"),
      storage: stub,
    });
    for await (const _entry of storage.list("l/")) {
      break;
    }
    const [op] = journal.snapshotOperations();
    expect(op?.result).toMatchObject({ classification: "list_ok", listed_entries: 1 });
    expect(journal.pendingOperationCount()).toBe(0);
  });

  test("a LIST that is never iterated journals nothing at all", async () => {
    const stub = new StubStorage();
    const { storage, journal } = wrapJournaledStorage({
      attemptId: asAttemptId("attempt-8b"),
      storage: stub,
    });
    void storage.list("l/");
    await Promise.resolve();
    expect(journal.snapshotOperations()).toEqual([]);
    expect(journal.pendingOperationCount()).toBe(0);
  });
});

describe("billing class", () => {
  /**
   * ONE definition, deliberately NOT a resolution. Manifest §11 item 1 records
   * three live and mutually inconsistent "Class A" definitions in this repo:
   *
   *   D1  packages/server/src/reads-pure.test.ts   put + delete
   *   D2  tests/integration/maintenance-e2e.test.ts put + delete + list
   *   D3  docs/about/cost-model.md                 put + list   (DELETE is $0)
   *       — matching bench/storage.ts's `billableClassAOps` getter and
   *         coordination design §4.5's `billableClassAOps = puts + lists`
   *
   * D1 governs a CI gate; D2 backs the published "< 1 Class A op / writer /
   * hour" claim; D3 governs the fold program's cost arguments. The journal uses
   * D3 because that is what §4.5 binds it to. This test exists so the
   * disagreement is discoverable evidence for the Protocol/product owner named
   * in §11, not so this lane resolves it.
   */
  test("uses the cost-model definition: puts and lists bill, deletes are free", () => {
    expect(billingClassOf("put")).toBe("A");
    expect(billingClassOf("list")).toBe("A");
    expect(billingClassOf("get")).toBe("B");
    expect(billingClassOf("delete")).toBe("free");
  });

  test("billingSummary counts settled rows by class", async () => {
    const stub = new StubStorage();
    const { storage, journal } = wrapJournaledStorage({
      attemptId: asAttemptId("attempt-bill"),
      storage: stub,
    });
    await storage.put("a", enc("1"));
    await storage.put("b", enc("2"));
    await storage.get("a");
    await storage.delete("b");
    for await (const _entry of storage.list("")) {
      /* drain */
    }
    expect(journal.billingSummary()).toEqual({ class_a: 3, class_b: 1, free: 1 });
  });

  test("a failed operation still counts — the request was still billed", async () => {
    const stub = new StubStorage();
    stub.failOn.set("put:x", new BaerlyError("Conflict", "precondition failed"));
    const { storage, journal } = wrapJournaledStorage({
      attemptId: asAttemptId("attempt-bill-2"),
      storage: stub,
    });
    await expect(storage.put("x", enc("v"))).rejects.toMatchObject({ code: "Conflict" });
    expect(journal.billingSummary()).toEqual({ class_a: 1, class_b: 0, free: 0 });
  });
});

describe("namespace journal", () => {
  test("tracks provisioning, PUT, and DELETE without any LIST", async () => {
    const stub = new StubStorage();
    const { storage, journal } = wrapJournaledStorage({
      attemptId: asAttemptId("attempt-ns-1"),
      storage: stub,
    });
    journal.recordProvisioned([
      { key: "seed/b", byte_length: 10 },
      { key: "seed/a", byte_length: 4 },
    ]);
    await storage.put("live/1", enc("abcd"));
    await storage.put("live/1", enc("abcdef"));
    await storage.delete("seed/a");
    const snapshot = journal.snapshotNamespace();
    expect(snapshot.schema).toBe(NAMESPACE_JOURNAL_VERSION);
    expect(snapshot.exact).toBe(true);
    expect(snapshot.uncertain_keys).toEqual([]);
    expect(snapshot.uncertainty).toEqual([]);
    expect(snapshot.entries).toEqual([
      { key: "live/1", byte_length: 6, last_operation_index: 1, source: "put" },
      { key: "seed/b", byte_length: 10, last_operation_index: null, source: "provisioned" },
    ]);
    expect(stub.calls.filter((c) => c.startsWith("list:"))).toEqual([]);
  });

  test("a conflicting PUT leaves namespace truth unchanged", async () => {
    const stub = new StubStorage();
    stub.failOn.set("put:c", new BaerlyError("Conflict", "precondition failed"));
    const { storage, journal } = wrapJournaledStorage({
      attemptId: asAttemptId("attempt-ns-2"),
      storage: stub,
    });
    journal.recordProvisioned([{ key: "c", byte_length: 3 }]);
    await expect(storage.put("c", enc("zzzz"))).rejects.toMatchObject({ code: "Conflict" });
    const snapshot = journal.snapshotNamespace();
    expect(snapshot.exact).toBe(true);
    expect(snapshot.entries).toEqual([
      { key: "c", byte_length: 3, last_operation_index: null, source: "provisioned" },
    ]);
  });

  test("an ambiguous PUT or DELETE failure marks that exact key uncertain", async () => {
    const stub = new StubStorage();
    stub.failOn.set("put:u", new BaerlyError("NetworkError", "retries exhausted"));
    stub.failOn.set("delete:d", abortedError());
    const { storage, journal } = wrapJournaledStorage({
      attemptId: asAttemptId("attempt-ns-3"),
      storage: stub,
    });
    journal.recordProvisioned([
      { key: "u", byte_length: 3 },
      { key: "d", byte_length: 5 },
      { key: "safe", byte_length: 1 },
    ]);
    await expect(storage.put("u", enc("x"))).rejects.toMatchObject({ code: "NetworkError" });
    await expect(storage.delete("d")).rejects.toThrow("aborted");
    const snapshot = journal.snapshotNamespace();
    expect(snapshot.exact).toBe(false);
    expect(snapshot.uncertain_keys).toEqual(["d", "u"]);
    expect(snapshot.entries).toEqual([
      { key: "safe", byte_length: 1, last_operation_index: null, source: "provisioned" },
    ]);
  });

  // ── REVISION 2: the evidence array, so a consumer can narrow ──────────────
  test("uncertainty carries the evidence needed to narrow without guessing", async () => {
    const stub = new StubStorage();
    stub.failOn.set("put:net", new BaerlyError("NetworkError", "retries exhausted"));
    stub.failOn.set("delete:pre", abortedError());
    const dead = new AbortController();
    dead.abort();
    const { storage, journal } = wrapJournaledStorage({
      attemptId: asAttemptId("attempt-ns-3b"),
      storage: stub,
    });
    await expect(storage.put("net", enc("x"))).rejects.toMatchObject({ code: "NetworkError" });
    await expect(storage.delete("pre", { signal: dead.signal })).rejects.toThrow("aborted");
    const snapshot = journal.snapshotNamespace();
    expect(snapshot.uncertainty).toEqual([
      {
        key: "net",
        operation_index: 0,
        method: "put",
        classification: "network_error",
        aborted_at_dispatch: false,
      },
      {
        key: "pre",
        operation_index: 1,
        method: "delete",
        classification: "aborted",
        aborted_at_dispatch: true,
      },
    ]);
    // Both are still uncertain — the journal fails CLOSED. The `pre` row simply
    // carries enough evidence for a consumer to decide otherwise, without the
    // journal baking in an assumption the `Storage` contract does not state.
    expect(snapshot.uncertain_keys).toEqual(["net", "pre"]);
    expect(snapshot.exact).toBe(false);
  });

  test("a later successful PUT clears both the key and its uncertainty row", async () => {
    const stub = new StubStorage();
    stub.failOn.set("put:flaky", new BaerlyError("NetworkError", "boom"));
    const { storage, journal } = wrapJournaledStorage({
      attemptId: asAttemptId("attempt-ns-3c"),
      storage: stub,
    });
    await expect(storage.put("flaky", enc("x"))).rejects.toMatchObject({ code: "NetworkError" });
    expect(journal.snapshotNamespace().exact).toBe(false);
    stub.failOn.delete("put:flaky");
    await storage.put("flaky", enc("xy"));
    const snapshot = journal.snapshotNamespace();
    expect(snapshot.exact).toBe(true);
    expect(snapshot.uncertain_keys).toEqual([]);
    expect(snapshot.uncertainty).toEqual([]);
    expect(snapshot.entries).toEqual([
      { key: "flaky", byte_length: 2, last_operation_index: 1, source: "put" },
    ]);
  });
  // ──────────────────────────────────────────────────────────────────────────

  test("LIST is journaled but never changes namespace truth", async () => {
    const stub = new StubStorage();
    stub.objects.set("ghost", { body: enc("xyz"), etag: '"g"' });
    const { storage, journal } = wrapJournaledStorage({
      attemptId: asAttemptId("attempt-ns-4"),
      storage: stub,
    });
    for await (const _entry of storage.list("")) {
      /* drain */
    }
    expect(journal.snapshotOperations()).toHaveLength(1);
    expect(journal.snapshotNamespace().entries).toEqual([]);
  });
});

describe("timer-free guarantee", () => {
  const SOURCE = readFileSync(
    fileURLToPath(new URL("./storage-journal.ts", import.meta.url)),
    "utf8",
  );

  test("the module contains no clock or timer call site", () => {
    expect(SOURCE).not.toMatch(/new\s+Date\b/);
    expect(SOURCE).not.toMatch(/Date\s*\.\s*now/);
    expect(SOURCE).not.toMatch(/performance\s*\.\s*now/);
    expect(SOURCE).not.toMatch(/process\s*\.\s*hrtime/);
    expect(SOURCE).not.toMatch(/set(?:Timeout|Interval|Immediate)\s*\(/);
  });

  test("the module imports nothing at runtime", () => {
    // `import type` is erased; a bare `import ... from` is not. The probe module
    // reads clocks by design, so importing it here would silently break the
    // guarantee above.
    expect(SOURCE).not.toMatch(/^import\s+(?!type\b)/m);
  });

  test("no journal operation reads a clock", async () => {
    const stub = new StubStorage();
    const { storage, journal } = wrapJournaledStorage({
      attemptId: asAttemptId("attempt-clock"),
      storage: stub,
    });
    const dateNow = vi.spyOn(Date, "now");
    const perfNow = vi.spyOn(performance, "now");
    try {
      await storage.put("k", enc("abc"));
      await storage.get("k");
      for await (const _entry of storage.list("")) {
        /* drain */
      }
      await storage.delete("k");
      journal.recordProvisioned([{ key: "z", byte_length: 1 }]);
      journal.snapshotOperations();
      journal.snapshotNamespace();
      journal.billingSummary();
    } finally {
      dateNow.mockRestore();
      perfNow.mockRestore();
    }
    expect(dateNow).not.toHaveBeenCalled();
    expect(perfNow).not.toHaveBeenCalled();
  });
});
