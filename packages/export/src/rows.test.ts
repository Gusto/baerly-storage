import { describe, expect, test } from "vitest";
import type { JSONArraylessObject } from "@baerly/protocol";
import { emitInsertStatements } from "./rows.ts";
import { inferPlanForCollection } from "./plan.ts";
import type { ExportRow } from "./types.ts";

const rowsFromRecord = (rec: Record<string, ExportRow>): ReadonlyMap<string, ExportRow> => {
  const m = new Map<string, ExportRow>();
  for (const [k, v] of Object.entries(rec)) {
    m.set(k, v);
  }
  return m;
};

const collect = async (iter: AsyncIterable<string>): Promise<string[]> => {
  const out: string[] = [];
  for await (const chunk of iter) {
    out.push(chunk);
  }
  return out;
};

describe("emitInsertStatements", () => {
  test("scalar columns — postgres", async () => {
    const rows = rowsFromRecord({
      a: { name: "alice", count: 1, active: true } as JSONArraylessObject,
      b: { name: "bob", count: 2, active: false } as JSONArraylessObject,
    });
    const plan = inferPlanForCollection({ rows, target: "postgres", table: "users" });
    const chunks = await collect(emitInsertStatements(plan, rows));
    expect(chunks).toEqual([
      'INSERT INTO "users" ("_id", "name", "count", "active") VALUES (\'a\', \'alice\', 1, true);\n',
      'INSERT INTO "users" ("_id", "name", "count", "active") VALUES (\'b\', \'bob\', 2, false);\n',
    ]);
  });

  test("scalar columns — sqlite (boolean as 0/1)", async () => {
    const rows = rowsFromRecord({
      a: { name: "alice", active: true } as JSONArraylessObject,
      b: { name: "bob", active: false } as JSONArraylessObject,
    });
    const plan = inferPlanForCollection({ rows, target: "sqlite", table: "users" });
    const chunks = await collect(emitInsertStatements(plan, rows));
    expect(chunks).toEqual([
      'INSERT INTO "users" ("_id", "name", "active") VALUES (\'a\', \'alice\', 1);\n',
      'INSERT INTO "users" ("_id", "name", "active") VALUES (\'b\', \'bob\', 0);\n',
    ]);
  });

  test("missing field → NULL", async () => {
    const rows = rowsFromRecord({
      a: { name: "alice", nickname: "al" } as JSONArraylessObject,
      b: { name: "bob" } as JSONArraylessObject,
    });
    const plan = inferPlanForCollection({ rows, target: "postgres", table: "users" });
    const chunks = await collect(emitInsertStatements(plan, rows));
    expect(chunks[1]).toBe(
      'INSERT INTO "users" ("_id", "name", "nickname") VALUES (\'b\', \'bob\', NULL);\n',
    );
  });

  test("JSON-encoded column — postgres jsonb", async () => {
    const rows = rowsFromRecord({
      a: { profile: { city: "sf", zip: 94110 } } as JSONArraylessObject,
    });
    const plan = inferPlanForCollection({ rows, target: "postgres", table: "users" });
    const chunks = await collect(emitInsertStatements(plan, rows));
    expect(chunks).toEqual([
      'INSERT INTO "users" ("_id", "profile") VALUES (\'a\', \'{"city":"sf","zip":94110}\');\n',
    ]);
  });

  test("JSON-encoded column — sqlite TEXT", async () => {
    const rows = rowsFromRecord({
      a: { profile: { city: "sf" } } as JSONArraylessObject,
    });
    const plan = inferPlanForCollection({ rows, target: "sqlite", table: "users" });
    const chunks = await collect(emitInsertStatements(plan, rows));
    expect(chunks).toEqual([
      'INSERT INTO "users" ("_id", "profile") VALUES (\'a\', \'{"city":"sf"}\');\n',
    ]);
  });

  test("apostrophe in string is doubled", async () => {
    const rows = rowsFromRecord({
      a: { note: "it's fine" } as JSONArraylessObject,
    });
    const plan = inferPlanForCollection({ rows, target: "postgres", table: "notes" });
    const chunks = await collect(emitInsertStatements(plan, rows));
    expect(chunks).toEqual([
      "INSERT INTO \"notes\" (\"_id\", \"note\") VALUES ('a', 'it''s fine');\n",
    ]);
  });

  test("mixed-primitive column — value is string-quoted, not JSON-encoded", async () => {
    const rows = rowsFromRecord({
      a: { val: "hello" } as JSONArraylessObject,
      b: { val: 42 } as JSONArraylessObject,
    });
    const plan = inferPlanForCollection({ rows, target: "postgres", table: "t" });
    const chunks = await collect(emitInsertStatements(plan, rows));
    // Numbers in a mixed-type column still render as their SQL form.
    expect(chunks).toEqual([
      'INSERT INTO "t" ("_id", "val") VALUES (\'a\', \'hello\');\n',
      'INSERT INTO "t" ("_id", "val") VALUES (\'b\', 42);\n',
    ]);
  });

  test("primitive + nested-object column → JSON-encoded for both rows", async () => {
    const rows = rowsFromRecord({
      a: { thing: "string-form" } as JSONArraylessObject,
      b: { thing: { nested: "obj" } } as JSONArraylessObject,
    });
    const plan = inferPlanForCollection({ rows, target: "postgres", table: "t" });
    const chunks = await collect(emitInsertStatements(plan, rows));
    expect(chunks).toEqual([
      'INSERT INTO "t" ("_id", "thing") VALUES (\'a\', \'"string-form"\');\n',
      'INSERT INTO "t" ("_id", "thing") VALUES (\'b\', \'{"nested":"obj"}\');\n',
    ]);
  });

  test("_id is read from the map key, not from the body", async () => {
    const rows = rowsFromRecord({
      "doc-1": { name: "alice" } as JSONArraylessObject,
    });
    const plan = inferPlanForCollection({ rows, target: "postgres", table: "u" });
    const chunks = await collect(emitInsertStatements(plan, rows));
    expect(chunks[0]).toContain("'doc-1'");
  });
});
