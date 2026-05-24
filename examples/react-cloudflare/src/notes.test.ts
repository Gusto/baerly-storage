import { test, expect } from "vitest";
import { Db, MemoryStorage } from "baerly-storage";
import config from "../baerly.config.ts";

test("notes round-trip", async () => {
  const db = Db.create({
    storage: new MemoryStorage(),
    app: "test",
    tenant: "t",
    config,
  });
  const { _id } = await db.table("notes").insert({ body: "hello" });
  const row = await db.table("notes").get(_id);
  expect(row?.body).toBe("hello");
});
