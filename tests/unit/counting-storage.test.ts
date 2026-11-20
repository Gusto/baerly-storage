import { describe, expect, test } from "vitest";
import { MemoryStorage } from "@baerly/protocol";
import { wrapCountingStorage } from "../fixtures/counting-storage.ts";

describe("counting-storage billable taxonomy", () => {
  test("billableClassAOps counts PUT + LIST but not the free DeleteObject", async () => {
    const c = wrapCountingStorage(new MemoryStorage());
    await c.storage.put("k", new Uint8Array([1]));
    await c.storage.delete("k");
    // one list iteration — drain the iterator; no entries expected (key was deleted)
    for await (const entry of c.storage.list("")) {
      void entry;
    }
    expect(c.puts).toBe(1);
    expect(c.deletes).toBe(1);
    expect(c.lists).toBe(1);
    // Operation/subrequest count keeps DELETE (a real CF subrequest).
    expect(c.classAOps).toBe(3);
    // Billing-correct: DeleteObject is $0 on both R2 and S3.
    expect(c.billableClassAOps).toBe(2);
  });

  test("gets counter increments on storage.get calls", async () => {
    const c = wrapCountingStorage(new MemoryStorage());
    await c.storage.put("k", new Uint8Array([1]));
    await c.storage.get("k");
    expect(c.gets).toBe(1);
  });
});

describe("counting-storage kind counts", () => {
  test("counts is a snapshot of the four per-kind counters", async () => {
    const c = wrapCountingStorage(new MemoryStorage());
    await c.storage.put("a", new Uint8Array([1]));
    await c.storage.put("b", new Uint8Array([1]));
    await c.storage.get("a");
    await c.storage.delete("b");
    for await (const entry of c.storage.list("")) {
      void entry;
    }
    expect(c.counts).toEqual({ get: 1, put: 2, delete: 1, list: 1 });
    c.reset();
    expect(c.counts).toEqual({ get: 0, put: 0, delete: 0, list: 0 });
  });
});

describe("counting-storage bytes", () => {
  test("bytesWritten sums put bodies, whatever the Uint8Array flavour", async () => {
    const c = wrapCountingStorage(new MemoryStorage());
    await c.storage.put("plain", new Uint8Array(10));
    await c.storage.put("buffer", Buffer.from("héllo")); // 6 UTF-8 bytes
    await c.storage.put("view", new Uint8Array(100).subarray(10, 14)); // 4 visible bytes
    await c.storage.put("empty", new Uint8Array(0));
    expect(c.bytesWritten).toBe(20);
    expect(c.bytesRead).toBe(0);
  });

  test("a rejected put still counts the bytes it sent", async () => {
    const c = wrapCountingStorage(new MemoryStorage());
    await c.storage.put("k", new Uint8Array(3));
    await expect(c.storage.put("k", new Uint8Array(5), { ifNoneMatch: "*" })).rejects.toMatchObject(
      { code: "WriteConflict" },
    );
    expect(c.bytesWritten).toBe(8);
    expect(c.puts).toBe(2);
  });

  test("bytesRead sums returned get bodies; a miss and a list add nothing", async () => {
    const c = wrapCountingStorage(new MemoryStorage());
    await c.storage.put("k", new Uint8Array(7));
    await c.storage.get("k");
    await c.storage.get("k");
    await c.storage.get("missing");
    for await (const entry of c.storage.list("")) {
      void entry;
    }
    expect(c.bytesRead).toBe(14);
    expect(c.gets).toBe(3);
  });

  test("reset zeroes the byte counters", async () => {
    const c = wrapCountingStorage(new MemoryStorage());
    await c.storage.put("k", new Uint8Array(7));
    await c.storage.get("k");
    c.reset();
    expect(c.bytesWritten).toBe(0);
    expect(c.bytesRead).toBe(0);
  });
});

describe("counting-storage key classifier", () => {
  const classify = (key: string): string | undefined => {
    if (key.startsWith("t/node/")) {
      return "node";
    }
    if (key.startsWith("t/head")) {
      return "head";
    }
    return undefined;
  };

  test("attributes get / put / delete and bytes to the key's class", async () => {
    const c = wrapCountingStorage(new MemoryStorage(), classify);
    await c.storage.put("t/node/a", new Uint8Array(10));
    await c.storage.put("t/node/b", new Uint8Array(20));
    await c.storage.put("t/head", new Uint8Array(2));
    await c.storage.put("t/other", new Uint8Array(99));
    await c.storage.get("t/node/a");
    await c.storage.get("t/node/absent");
    await c.storage.get("t/other");
    await c.storage.delete("t/node/b");

    expect(c.classCounts("node")).toEqual({
      gets: 2,
      puts: 2,
      deletes: 1,
      bytesRead: 10,
      bytesWritten: 30,
    });
    expect(c.classCounts("head")).toEqual({
      gets: 0,
      puts: 1,
      deletes: 0,
      bytesRead: 0,
      bytesWritten: 2,
    });
    // Unclassified keys stay out of every class but in the global counters.
    expect([...c.classes.keys()].toSorted()).toEqual(["head", "node"]);
    expect(c.puts).toBe(4);
    expect(c.bytesWritten).toBe(131);
    expect(c.bytesRead).toBe(109);
  });

  test("a class never seen reads as zeros; no classifier means no classes; reset clears", async () => {
    const plain = wrapCountingStorage(new MemoryStorage());
    await plain.storage.put("t/node/a", new Uint8Array(1));
    expect(plain.classes.size).toBe(0);
    expect(plain.classCounts("node").puts).toBe(0);

    const c = wrapCountingStorage(new MemoryStorage(), classify);
    await c.storage.put("t/node/a", new Uint8Array(1));
    expect(c.classCounts("node").puts).toBe(1);
    c.reset();
    expect(c.classes.size).toBe(0);
    expect(c.classCounts("node").puts).toBe(0);
  });
});
