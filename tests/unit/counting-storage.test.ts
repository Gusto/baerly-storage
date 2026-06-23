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
});
