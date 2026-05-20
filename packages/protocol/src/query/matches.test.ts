import { describe, expect, test } from "vitest";

import type { Predicate } from "../table-api.ts";
import type { JSONObject } from "../json.ts";

import { matches } from "./matches.ts";

describe("matches — equality and traversal", () => {
  test("top-level equality match and miss", () => {
    expect(matches({ status: "open" }, { status: "open" })).toBe(true);
    expect(matches({ status: "open" }, { status: "closed" })).toBe(false);
    expect(matches({ status: "open" }, {})).toBe(false);
  });

  test("dotted-path traversal hit and miss", () => {
    const doc: JSONObject = { assignee: { team: "platform", oncall: "a" } };
    expect(matches({ "assignee.team": "platform" }, doc)).toBe(true);
    expect(matches({ "assignee.team": "billing" }, doc)).toBe(false);
    expect(matches({ "assignee.missing": "platform" }, doc)).toBe(false);
  });

  test("sub-predicate as open-world filter (extra doc keys allowed)", () => {
    const doc: JSONObject = { assignee: { team: "platform", oncall: "a" } };
    expect(matches({ assignee: { team: "platform" } }, doc)).toBe(true);
    expect(matches({ assignee: { team: "billing" } }, doc)).toBe(false);
  });

  test("sub-predicate fails when doc lacks the key", () => {
    expect(matches({ assignee: { team: "platform" } }, {})).toBe(false);
  });

  test("path traversal stops at primitive / null / array", () => {
    expect(matches({ "a.b": "c" }, { a: "literal" })).toBe(false);
    expect(matches({ "a.b": "c" }, { a: null } as unknown as JSONObject)).toBe(false);
    expect(matches({ "a.b": "c" }, { a: [1, 2] })).toBe(false);
  });

  test("sub-predicate against array / null / primitive in doc is false", () => {
    expect(matches({ a: { b: "c" } }, { a: "literal" })).toBe(false);
    expect(matches({ a: { b: "c" } }, { a: null } as unknown as JSONObject)).toBe(false);
    expect(matches({ a: { b: "c" } }, { a: [1, 2] })).toBe(false);
  });

  test("empty predicate matches every document", () => {
    expect(matches({}, {})).toBe(true);
    expect(matches({}, { a: 1, b: "x", nested: { d: true } })).toBe(true);
    expect(matches({}, { arr: [1, 2, 3] })).toBe(true);
  });

  test("number / boolean equality", () => {
    expect(matches({ count: 7 }, { count: 7 })).toBe(true);
    expect(matches({ count: 7 }, { count: 8 })).toBe(false);
    expect(matches({ archived: false }, { archived: false })).toBe(true);
    expect(matches({ archived: false }, { archived: true })).toBe(false);
  });

  test("AND-conjunction across multiple top-level keys", () => {
    const doc: JSONObject = { status: "open", priority: "p1" };
    expect(matches({ status: "open", priority: "p1" }, doc)).toBe(true);
    expect(matches({ status: "open", priority: "p2" }, doc)).toBe(false);
  });

  test("type mismatch on a terminal value is a miss, not a throw", () => {
    expect(matches({ count: 7 }, { count: "7" } as unknown as JSONObject)).toBe(false);
    expect(matches({ archived: false }, { archived: "false" } as unknown as JSONObject)).toBe(
      false,
    );
  });
});

describe("matches — operator-object", () => {
  test("$eq routes through equality", () => {
    expect(matches({ status: { $eq: "open" } } as unknown as Predicate, { status: "open" })).toBe(
      true,
    );
    expect(matches({ status: { $eq: "open" } } as unknown as Predicate, { status: "closed" })).toBe(
      false,
    );
  });

  test("$gt / $gte on numbers (boundary inclusivity)", () => {
    expect(matches({ x: { $gt: 5 } } as unknown as Predicate, { x: 5 })).toBe(false);
    expect(matches({ x: { $gt: 5 } } as unknown as Predicate, { x: 6 })).toBe(true);
    expect(matches({ x: { $gte: 5 } } as unknown as Predicate, { x: 5 })).toBe(true);
    expect(matches({ x: { $gte: 5 } } as unknown as Predicate, { x: 4 })).toBe(false);
  });

  test("$lt / $lte on numbers (boundary inclusivity)", () => {
    expect(matches({ x: { $lt: 5 } } as unknown as Predicate, { x: 5 })).toBe(false);
    expect(matches({ x: { $lt: 5 } } as unknown as Predicate, { x: 4 })).toBe(true);
    expect(matches({ x: { $lte: 5 } } as unknown as Predicate, { x: 5 })).toBe(true);
    expect(matches({ x: { $lte: 5 } } as unknown as Predicate, { x: 6 })).toBe(false);
  });

  test("range ops on ISO date strings", () => {
    const p = {
      created_at: { $gte: "2026-01-01", $lt: "2026-02-01" },
    } as unknown as Predicate;
    expect(matches(p, { created_at: "2025-12-31" })).toBe(false);
    expect(matches(p, { created_at: "2026-01-01" })).toBe(true);
    expect(matches(p, { created_at: "2026-01-15" })).toBe(true);
    expect(matches(p, { created_at: "2026-02-01" })).toBe(false);
    expect(matches(p, { created_at: "2026-02-15" })).toBe(false);
  });

  test("range ops always-miss on type-mismatch / boolean / null / missing", () => {
    // Numeric bound vs. string actual → miss, not throw.
    expect(
      matches({ x: { $gte: 1 } } as unknown as Predicate, { x: "1" } as unknown as JSONObject),
    ).toBe(false);
    // String bound vs. number actual → miss.
    expect(
      matches({ x: { $gte: "a" } } as unknown as Predicate, { x: 1 } as unknown as JSONObject),
    ).toBe(false);
    // Missing key → miss.
    expect(matches({ x: { $gte: 1 } } as unknown as Predicate, {})).toBe(false);
    // Null actual → miss.
    expect(
      matches({ x: { $gte: 1 } } as unknown as Predicate, { x: null } as unknown as JSONObject),
    ).toBe(false);
  });

  test("$in primitive membership", () => {
    expect(
      matches({ priority: { $in: ["p1", "p2"] } } as unknown as Predicate, { priority: "p1" }),
    ).toBe(true);
    expect(
      matches({ priority: { $in: ["p1", "p2"] } } as unknown as Predicate, { priority: "p3" }),
    ).toBe(false);
    expect(matches({ x: { $in: [1, 2, 3] } } as unknown as Predicate, { x: 2 })).toBe(true);
    expect(matches({ x: { $in: [1, 2, 3] } } as unknown as Predicate, { x: 4 })).toBe(false);
  });

  test("$in sub-predicate members (open-world)", () => {
    const p = {
      assignee: { $in: [{ team: "platform" }, { team: "billing" }] },
    } as unknown as Predicate;
    expect(matches(p, { assignee: { team: "platform", oncall: "a" } })).toBe(true);
    expect(matches(p, { assignee: { team: "billing" } })).toBe(true);
    expect(matches(p, { assignee: { team: "growth" } })).toBe(false);
  });

  test("dotted-path key with operator value", () => {
    const doc: JSONObject = { meta: { count: 7 } };
    expect(matches({ "meta.count": { $gte: 5 } } as unknown as Predicate, doc)).toBe(true);
    expect(matches({ "meta.count": { $gte: 10 } } as unknown as Predicate, doc)).toBe(false);
  });

  test("AND across multiple ops on one field", () => {
    const p = { count: { $gte: 1, $lt: 10 } } as unknown as Predicate;
    expect(matches(p, { count: 0 })).toBe(false);
    expect(matches(p, { count: 1 })).toBe(true);
    expect(matches(p, { count: 9 })).toBe(true);
    expect(matches(p, { count: 10 })).toBe(false);
  });
});
