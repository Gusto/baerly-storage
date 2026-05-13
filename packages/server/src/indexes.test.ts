/* eslint-disable no-underscore-dangle -- `_id` is the locked
   primary-key field on document shapes (see `@baerly/protocol`'s
   `Table<T>`); this test threads it through projection helpers. */

import { describe, expect, test } from "vitest";
import {
  allIndexKeysFor,
  encodeIndexValue,
  indexKeyFor,
  indexKeyPrefix,
  projectIndexValues,
  validateIndexDefinition,
} from "./indexes.ts";

describe("encodeIndexValue", () => {
  test("distinct values produce distinct encodings", () => {
    const a = encodeIndexValue("open");
    const b = encodeIndexValue("closed");
    expect(a).not.toBe(b);
  });

  test("equal values produce byte-equal encodings", () => {
    expect(encodeIndexValue("open")).toBe(encodeIndexValue("open"));
  });

  test("number 5 and string '5' encode differently", () => {
    expect(encodeIndexValue(5)).not.toBe(encodeIndexValue("5"));
  });

  test("null / undefined encode to '0' (the sentinel empty segment)", () => {
    expect(encodeIndexValue(null)).toBe("0");
    expect(encodeIndexValue(undefined)).toBe("0");
  });

  test("encoding uses only the lowercase base-32 alphabet", () => {
    const enc = encodeIndexValue("the quick brown fox");
    expect(enc).toMatch(/^[0-9a-v]+$/);
  });

  test("encoded segment never empty (no '//' in composed key)", () => {
    expect(encodeIndexValue("").length).toBeGreaterThan(0);
  });
});

describe("indexKeyFor", () => {
  test("single-field key shape", () => {
    const k = indexKeyFor(
      "manifests/tickets",
      { name: "by_status", on: "status" },
      ["open"],
      "t-1",
    );
    expect(k).toBe(`manifests/tickets/index/by_status/${encodeIndexValue("open")}/t-1.json`);
  });

  test("composite key uses '/' between value segments", () => {
    const k = indexKeyFor(
      "manifests/tickets",
      { name: "by_status_priority", on: ["status", "priority"] },
      ["open", "high"],
      "t-1",
    );
    expect(k.split("/")).toContain(encodeIndexValue("open"));
    expect(k.split("/")).toContain(encodeIndexValue("high"));
    expect(k.endsWith("/t-1.json")).toBe(true);
  });
});

describe("indexKeyPrefix", () => {
  test("includes trailing slash for list(prefix) walks", () => {
    expect(indexKeyPrefix("manifests/tickets", "by_status")).toBe(
      "manifests/tickets/index/by_status/",
    );
  });
});

describe("projectIndexValues", () => {
  test("returns the single-field value tuple", () => {
    const v = projectIndexValues(
      { name: "by_status", on: "status" },
      {
        _id: "t-1",
        status: "open",
      },
    );
    expect(v).toEqual(["open"]);
  });

  test("returns the composite value tuple in declaration order", () => {
    const v = projectIndexValues(
      { name: "by_x", on: ["a", "b"] },
      {
        _id: "t-1",
        a: "x",
        b: "y",
      },
    );
    expect(v).toEqual(["x", "y"]);
  });

  test("returns undefined when the field is missing", () => {
    const v = projectIndexValues({ name: "n", on: "missing" }, { _id: "x" });
    expect(v).toBeUndefined();
  });

  test("returns undefined when any composite field is missing", () => {
    const v = projectIndexValues({ name: "n", on: ["a", "b"] }, { _id: "x", a: "ok" });
    expect(v).toBeUndefined();
  });

  test("rejects dotted-path 'on'", () => {
    expect(() => projectIndexValues({ name: "n", on: "a.b" }, { _id: "x" })).toThrow(/dotted-path/);
  });

  test("returns undefined for undefined body", () => {
    expect(projectIndexValues({ name: "n", on: "x" }, undefined)).toBeUndefined();
  });
});

describe("allIndexKeysFor", () => {
  test("emits one key per declared index when the doc has all fields", () => {
    const keys = allIndexKeysFor(
      "manifests/tickets",
      [
        { name: "by_status", on: "status" },
        { name: "by_assignee", on: "assignee" },
      ],
      { _id: "t-1", status: "open", assignee: "alice" },
      "t-1",
    );
    expect(keys).toHaveLength(2);
    expect(keys[0]).toContain("/by_status/");
    expect(keys[1]).toContain("/by_assignee/");
  });

  test("skips an index when the projected field is missing", () => {
    const keys = allIndexKeysFor(
      "manifests/tickets",
      [
        { name: "by_status", on: "status" },
        { name: "by_assignee", on: "assignee" },
      ],
      { _id: "t-1", status: "open" },
      "t-1",
    );
    expect(keys).toHaveLength(1);
    expect(keys[0]).toContain("/by_status/");
  });

  test("undefined body produces no keys", () => {
    const keys = allIndexKeysFor(
      "manifests/tickets",
      [{ name: "by_status", on: "status" }],
      undefined,
      "t-1",
    );
    expect(keys).toEqual([]);
  });
});

describe("validateIndexDefinition", () => {
  test("accepts a well-formed single-field definition", () => {
    expect(() => validateIndexDefinition({ name: "by_status", on: "status" })).not.toThrow();
  });

  test("accepts a well-formed composite definition", () => {
    expect(() => validateIndexDefinition({ name: "by_x", on: ["a", "b"] })).not.toThrow();
  });

  test("rejects names with uppercase or dashes", () => {
    expect(() => validateIndexDefinition({ name: "Bad-Name", on: "x" })).toThrow(/match/);
  });

  test("rejects names starting with a digit", () => {
    expect(() => validateIndexDefinition({ name: "1starts", on: "x" })).toThrow(/match/);
  });

  test("rejects an empty 'on' string", () => {
    expect(() => validateIndexDefinition({ name: "ok_name", on: "" })).toThrow(/non-empty/);
  });

  test("rejects an empty 'on' array", () => {
    expect(() => validateIndexDefinition({ name: "ok_name", on: [] })).toThrow(/non-empty/);
  });
});
