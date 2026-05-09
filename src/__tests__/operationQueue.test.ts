import { expect, test, describe } from "vitest";
import { OperationQueue } from "../operationQueue";
import { type DeleteValue, type ResolvedRef, uuid } from "../types";
import type { JSONValue } from "../json";
import { createStore } from "idb-keyval";
import "fake-indexeddb/auto";

const requeue = (
  q: OperationQueue<string>,
): ((values: Map<ResolvedRef, JSONValue | DeleteValue>, label?: string) => Promise<void>) => {
  return async (values: Map<ResolvedRef, JSONValue | DeleteValue>, label?: string) => {
    const op = Promise.resolve("op");
    await q.propose(op, values, true);
    if (label) await q.label(op, label, true);
  };
};

const DEFAULT_KEY = {
  key: "foo",
  bucket: "bar",
};

describe("operation_queue", () => {
  test("Proposed ops appear in mask", async () => {
    const q = new OperationQueue();
    const op = Promise.resolve("a");
    const values = new Map<ResolvedRef, JSONValue>();
    const key = DEFAULT_KEY;
    values.set(key, "b");
    q.propose(op, values);
    expect((await q.flatten()).get(key)?.[0]).toBe("b");
  });

  test("Proposed ops can be labelled and confirmed", async () => {
    const q = new OperationQueue();
    const op = Promise.resolve("a");
    const values = new Map<ResolvedRef, JSONValue>();
    const key = DEFAULT_KEY;
    values.set(key, "b");
    q.propose(op, values);
    expect((await q.flatten()).get(key)?.[0]).toBe("b");
    q.label(op, "a");
    q.confirm("a");
    expect((await q.flatten()).get(key)?.[0]).toBe(undefined);
  });

  test("Proposed ops can be labelled and cancelled", async () => {
    const q = new OperationQueue();
    const op = Promise.resolve("a");
    const values = new Map<ResolvedRef, JSONValue>();
    const key = DEFAULT_KEY;
    values.set(key, "b");
    q.propose(op, values);
    expect((await q.flatten()).get(key)?.[0]).toBe("b");
    q.cancel(op);
    expect((await q.flatten()).get(key)?.[0]).toBe(undefined);
  });

  test("Order of operations is preserved after confirmations", async () => {
    const q = new OperationQueue();

    const key = DEFAULT_KEY;
    const totalOps = 100;

    // Propose and label 100 operations
    for (let i = 0; i < totalOps; i++) {
      const op = Promise.resolve({});
      const values = new Map([[key, i]]);
      q.propose(op, values);
      q.label(op, i.toString());
    }

    expect((await q.flatten()).get(key)?.[0]).toBe(totalOps - 1);
    // Confirm operations and check the decrement in flatten output
    for (let i = totalOps - 1; i > 0; i--) {
      q.confirm(i.toString());
      expect((await q.flatten()).get(key)?.[0]).toBe(i - 1);
    }
  });

  test("Proposed operations can be stored to disk and restored", async () => {
    const store = createStore(uuid(), uuid());
    const q = new OperationQueue(store);
    const op = Promise.resolve("a");
    const values = new Map<ResolvedRef, JSONValue>();
    const key = DEFAULT_KEY;
    values.set(key, "b");
    q.propose(op, values);
    expect((await q.flatten()).get(key)?.[0]).toBe("b");
    const restored = new OperationQueue();
    await restored.restore(store, requeue(restored));

    expect((await restored.flatten()).get(key)?.[0]).toBe("b");
  });

  test("Labelled operations can be stored to disk, restored and confirmed", async () => {
    const store = createStore(uuid(), uuid());
    const q = new OperationQueue(store);
    const op = Promise.resolve("a");
    const values = new Map<ResolvedRef, JSONValue>();
    const key = DEFAULT_KEY;
    values.set(key, "b");
    q.propose(op, values);
    q.label(op, "a");

    const restored = new OperationQueue();
    await restored.restore(store, requeue(restored));

    expect((await restored.flatten()).get(key)?.[0]).toBe("b");
    restored.confirm("a");
    expect((await restored.flatten()).get(key)?.[0]).toBe(undefined);
  });

  test("Order of operations is preserved after restore", async () => {
    const store = createStore(uuid(), uuid());
    const q = new OperationQueue(store);

    const key = DEFAULT_KEY;
    const totalOps = 100;

    // Propose and label 100 operations
    for (let i = 0; i < totalOps; i++) {
      const op = Promise.resolve({});
      const values = new Map([[key, i]]);
      q.propose(op, values);
      q.label(op, i.toString());
    }

    const restored = new OperationQueue();
    await restored.restore(store, requeue(restored));

    expect((await restored.flatten()).get(key)?.[0]).toBe(totalOps - 1);
    // Confirm operations and check the decrement in flatten output
    for (let i = totalOps - 1; i > 0; i--) {
      restored.confirm(i.toString());
      expect((await restored.flatten()).get(key)?.[0]).toBe(i - 1);
    }
  });
});
