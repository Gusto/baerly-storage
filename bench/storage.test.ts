import { describe, test, expect } from "vitest";
import { MemoryStorage } from "@baerly/protocol";
import { CountingStorage } from "./storage.ts";

describe("CountingStorage per-op counters", () => {
  test("counts get / put / delete / list distinctly", async () => {
    const c = new CountingStorage(new MemoryStorage());
    await c.put("tenant-1/coll-A/key1", new Uint8Array([1, 2, 3]));
    await c.get("tenant-1/coll-A/key1");
    await c.delete("tenant-1/coll-A/key1");
    for await (const _ of c.list("tenant-1/coll-A/")) {
      /* drain */
    }
    expect(c.putCount).toBe(1);
    expect(c.getCount).toBe(1);
    expect(c.deleteCount).toBe(1);
    expect(c.listCount).toBe(1);
    expect(c.headCount).toBe(0);
  });

  test("legacy classAOps / classBOps stay synchronized", async () => {
    const c = new CountingStorage(new MemoryStorage());
    await c.put("a/b", new Uint8Array([1]));
    await c.put("a/b", new Uint8Array([2]));
    await c.get("a/b");
    expect(c.classAOps).toBe(2); // 2 PUT
    expect(c.classBOps).toBe(1); // 1 GET
    expect(c.putCount + c.deleteCount + c.listCount).toBe(c.classAOps);
    expect(c.getCount).toBe(c.classBOps);
  });

  test("bytes_read and bytes_written track payload size", async () => {
    const c = new CountingStorage(new MemoryStorage());
    const body = new Uint8Array(1234);
    await c.put("k", body);
    await c.get("k");
    expect(c.bytesWritten).toBe(1234);
    expect(c.bytesRead).toBe(1234);
  });

  test("ops_by_prefix buckets to first two segments", async () => {
    const c = new CountingStorage(new MemoryStorage());
    await c.put("tenant-1/coll-A/k1", new Uint8Array([1]));
    await c.put("tenant-1/coll-A/k2", new Uint8Array([1]));
    await c.put("tenant-1/coll-B/k1", new Uint8Array([1]));
    await c.put("tenant-2/coll-A/k1", new Uint8Array([1]));
    const snap = c.snapshot();
    expect(snap.ops_by_prefix["tenant-1/coll-A"]?.put).toBe(2);
    expect(snap.ops_by_prefix["tenant-1/coll-B"]?.put).toBe(1);
    expect(snap.ops_by_prefix["tenant-2/coll-A"]?.put).toBe(1);
  });

  test("snapshot omits latency_ms.by_op verbs with no samples", async () => {
    const c = new CountingStorage(new MemoryStorage());
    await c.put("k", new Uint8Array([1]));
    const snap = c.snapshot();
    expect(snap.latency_ms.by_op.put).toBeDefined();
    expect(snap.latency_ms.by_op.get).toBeUndefined();
    expect(snap.latency_ms.by_op.head).toBeUndefined();
  });

  test("reset() clears every counter in lock-step", async () => {
    const c = new CountingStorage(new MemoryStorage());
    await c.put("a/b/c", new Uint8Array([1, 2, 3]));
    await c.get("a/b/c");
    c.reset();
    expect(c.classAOps).toBe(0);
    expect(c.classBOps).toBe(0);
    expect(c.putCount).toBe(0);
    expect(c.bytesRead).toBe(0);
    expect(c.bytesWritten).toBe(0);
    expect(c.opsByPrefix.size).toBe(0);
    const snap = c.snapshot();
    expect(snap.object_store.put).toBe(0);
    expect(snap.latency_ms.by_op.put).toBeUndefined();
  });
});
