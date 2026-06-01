/* eslint-disable no-underscore-dangle -- `_id` is the locked primary key. */
import { fc, test } from "@fast-check/vitest";
import { describe, expect } from "vitest";
import {
  type DocumentData,
  type JSONObject,
  type JSONValue,
  matchesWire,
  type PredicateWire,
} from "@baerly/protocol";
import { allIndexKeysFor, type IndexDefinition } from "./indexes.ts";

const LOG_PREFIX = "app/x/tenant/t/manifests/tickets";

// Fields the doc and the predicate share. Indexed field is always `priority`
// (numeric, range-friendly); predicate clauses range over `status`/`priority`.
const FIELDS = ["status", "priority", "assignee"] as const;

// Scalar-or-null field values. `null` is not a `DocumentValue`, but the
// runtime wire body can carry it (projectIndexValues guards against it at
// indexes.ts:348), so the body is modelled as a JSONObject and cast to
// DocumentData only at the allIndexKeysFor boundary — exactly how a real
// merged post-image with a null field reaches the writer.
const scalarArb: fc.Arbitrary<JSONValue> = fc.oneof(
  fc.constantFrom("open", "closed", "wip"),
  fc.integer({ min: 0, max: 5 }),
  fc.boolean(),
  fc.constant(null),
);

// Doc body: each field independently present-or-absent, scalar-or-null. No
// arrays (projectIndexValues throws on arrays — out of scope for this prop).
const bodyArb: fc.Arbitrary<JSONObject> = fc
  .record(
    {
      _id: fc.constant("d1"),
      status: scalarArb,
      priority: scalarArb,
      assignee: scalarArb,
    },
    { requiredKeys: ["_id"] },
  )
  .map((r) => {
    const fieldValues = r as Record<string, JSONValue | undefined>;
    const out: JSONObject = { _id: r._id };
    for (const f of FIELDS) {
      const value = fieldValues[f];
      if (value !== undefined) {
        out[f] = value;
      }
    }
    return out;
  });

const clauseArb = fc.record({
  op: fc.constantFrom("eq", "gt", "gte", "lt", "lte") as fc.Arbitrary<
    "eq" | "gt" | "gte" | "lt" | "lte"
  >,
  field: fc.constantFrom("status", "priority"),
  value: fc.oneof(fc.constantFrom("open", "closed", "wip"), fc.integer({ min: 0, max: 5 })),
});

const wireArb: fc.Arbitrary<PredicateWire> = fc
  .array(clauseArb, { minLength: 0, maxLength: 3 })
  .map((clauses) => ({ clauses }));

const isProjectable = (body: JSONObject, field: string): boolean => {
  const v = body[field];
  return v !== undefined && v !== null && !Array.isArray(v);
};

describe("allIndexKeysFor — filtered-index emission matches matchesWire ∧ projectable", () => {
  test.prop({ body: bodyArb, predicate: fc.option(wireArb, { nil: undefined }) })(
    "emits a key iff (no predicate OR predicate matches) AND field projectable",
    ({ body, predicate }) => {
      const def: IndexDefinition =
        predicate === undefined
          ? { name: "by_priority", on: "priority" }
          : { name: "by_priority", on: "priority", predicate };

      const docId = body["_id"] as string;
      const keys = allIndexKeysFor(LOG_PREFIX, [def], body as DocumentData, docId);

      const matches = predicate === undefined ? true : matchesWire(predicate, body);
      const expectKey = matches && isProjectable(body, "priority");
      expect(keys.length).toBe(expectKey ? 1 : 0);
    },
  );

  test.prop({ body: bodyArb })(
    "an unfiltered index is unaffected by a sibling filtered index",
    ({ body }) => {
      const defs: ReadonlyArray<IndexDefinition> = [
        { name: "by_status", on: "status" },
        {
          name: "by_priority",
          on: "priority",
          predicate: { clauses: [{ op: "eq", field: "status", value: "open" }] },
        },
      ];
      const docId = body["_id"] as string;
      const keys = allIndexKeysFor(LOG_PREFIX, defs, body as DocumentData, docId);
      // The unfiltered by_status key is present iff `status` is projectable,
      // regardless of the filtered index's predicate.
      const statusKeys = keys.filter((k) => k.includes("/index/by_status/"));
      expect(statusKeys.length).toBe(isProjectable(body, "status") ? 1 : 0);
    },
  );

  // ── Concrete hand-checked cases ──

  test("predicate match + projectable field ⇒ one key", () => {
    const def: IndexDefinition = {
      name: "by_priority",
      on: "priority",
      predicate: { clauses: [{ op: "eq", field: "status", value: "open" }] },
    };
    const body: DocumentData = { _id: "d1", status: "open", priority: 2 };
    const keys = allIndexKeysFor(LOG_PREFIX, [def], body, "d1");
    expect(keys.length).toBe(1);
  });

  test("predicate miss ⇒ zero keys even when field projectable", () => {
    const def: IndexDefinition = {
      name: "by_priority",
      on: "priority",
      predicate: { clauses: [{ op: "eq", field: "status", value: "open" }] },
    };
    const body: DocumentData = { _id: "d1", status: "closed", priority: 2 };
    const keys = allIndexKeysFor(LOG_PREFIX, [def], body, "d1");
    expect(keys.length).toBe(0);
  });

  test("predicate match but indexed field null ⇒ zero keys", () => {
    const def: IndexDefinition = {
      name: "by_priority",
      on: "priority",
      predicate: { clauses: [{ op: "eq", field: "status", value: "open" }] },
    };
    // `null` is wire-legal but not a DocumentValue; model via JSONObject.
    const body: JSONObject = { _id: "d1", status: "open", priority: null };
    const keys = allIndexKeysFor(LOG_PREFIX, [def], body as DocumentData, "d1");
    expect(keys.length).toBe(0);
  });
});
