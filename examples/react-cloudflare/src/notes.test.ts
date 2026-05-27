// Example test for the shipped `notes` collection. Replace or
// delete when you change the schema in `baerly.config.ts` — the
// import on line below will stop typechecking once `notes` is
// gone.
import { test, expect } from "vitest";
import { Db, MemoryStorage } from "@gusto/baerly-storage";
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
