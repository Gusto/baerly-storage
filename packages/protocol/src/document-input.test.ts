import { describe, expect, test } from "vitest";
import { assertDocumentValues, assertInsertIdType } from "./document-input.ts";
import { BaerlyError } from "./errors.ts";

const refusal = (value: unknown, verb = "insert"): BaerlyError => {
  try {
    assertDocumentValues(value, verb);
  } catch (error) {
    expect(error).toBeInstanceOf(BaerlyError);
    expect(error).toMatchObject({ code: "InvalidConfig" });
    return error as BaerlyError;
  }
  throw new Error("expected assertDocumentValues to throw");
};

class Ticket {
  title = "a";
}

describe("assertDocumentValues", () => {
  test.each<readonly [string, unknown]>([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["undefined", undefined],
    ["Date", new Date(0)],
    ["Map", new Map()],
    ["Set", new Set()],
    ["Uint8Array", new Uint8Array(1)],
    ["class instance", new Ticket()],
    ["boxed number", Object(1)],
    ["boxed string", Object("a")],
    ["function", () => 1],
    ["symbol", Symbol("s")],
    ["bigint", 1n],
  ])("refuses a nested %s, naming its path", (_label, value) => {
    const error = refusal({ _id: "a", outer: { list: [1, value] } });
    expect(error.message).toContain("outer.list[1]");
    expect(error.resolution).toBeTypeOf("string");
  });

  test.each(["own", "inherited", "array", "root", "accessor"])(
    "refuses a %s toJSON hook without running it",
    (kind) => {
      let calls = 0;
      const hook = () => {
        calls++;
        return { amount: Number.NaN };
      };
      const container = kind === "array" ? [10] : { amount: 10 };
      if (kind === "inherited" || kind === "array" || kind === "root") {
        Object.setPrototypeOf(
          container,
          Object.create(Object.getPrototypeOf(container), {
            toJSON: { value: hook },
          }),
        );
      } else {
        Object.defineProperty(
          container,
          "toJSON",
          kind === "accessor"
            ? {
                get() {
                  calls++;
                  return hook;
                },
              }
            : { value: hook },
        );
      }
      const error = refusal(kind === "root" ? container : { nested: container });
      expect(error.code).toBe("InvalidConfig");
      expect(calls).toBe(0);
    },
  );

  test("allows a non-callable toJSON member that shadows a prototype hook", () => {
    class Root {
      toJSON = null;
      amount = 10;
    }
    Object.defineProperty(Root.prototype, "toJSON", { value: () => Number.NaN });
    expect(() => assertDocumentValues(new Root(), "insert")).not.toThrow();
    expect(() => assertDocumentValues({ nested: { toJSON: "data" } }, "insert")).not.toThrow();
  });

  test("refuses a missing array element", () => {
    // eslint-disable-next-line no-sparse-arrays -- the hole is the subject
    expect(refusal({ list: [1, , 3] }).message).toContain("list[1]");
  });

  test("refuses a circular reference", () => {
    const doc: Record<string, unknown> = { a: {} };
    (doc["a"] as Record<string, unknown>)["back"] = doc;
    expect(refusal(doc).message).toContain("a.back");
  });

  test("accepts a non-plain root and checks its own fields", () => {
    expect(() => assertDocumentValues(new Ticket(), "insert")).not.toThrow();
    const ticket = Object.assign(new Ticket(), { score: Number.NaN });
    expect(refusal(ticket).message).toContain("score");
  });

  test("refuses a value at the root itself", () => {
    expect(refusal(Number.NaN).message).toContain("the document is NaN");
  });

  test("undefinedMembersAbsent allows undefined members but not elements", () => {
    const options = { undefinedMembersAbsent: true };
    expect(() =>
      assertDocumentValues({ a: undefined, b: { c: undefined } }, "update", options),
    ).not.toThrow();
    expect(() => assertDocumentValues({ list: [undefined] }, "update", options)).toThrow(
      expect.objectContaining({ code: "InvalidConfig" }),
    );
    expect(() => assertDocumentValues({ a: Number.NaN }, "update", options)).toThrow(
      expect.objectContaining({ code: "InvalidConfig" }),
    );
  });

  test("quotes a non-identifier key in the path", () => {
    expect(refusal({ "a b": { c: Number.NaN } }).message).toContain('["a b"].c');
  });

  test("names the verb", () => {
    expect(refusal({ a: Number.NaN }, "update").message).toMatch(/^update: /);
  });

  test("accepts the JSON document domain", () => {
    const shared = { x: 1 };
    expect(() =>
      assertDocumentValues(
        {
          _id: undefined,
          s: "",
          n: -0,
          f: 1.5,
          b: false,
          z: null,
          list: [null, [shared], { shared }],
          bare: Object.create(null) as object,
          shared,
        },
        "insert",
      ),
    ).not.toThrow();
  });

  test("a nested _id: undefined is still refused", () => {
    expect(refusal({ a: { _id: undefined } }).message).toContain("a._id");
  });

  test("walks a deep document without overflowing the call stack, with a bounded path", () => {
    let deep: Record<string, unknown> = { leaf: Number.NaN };
    for (let i = 0; i < 100_000; i++) {
      deep = { d: deep };
    }
    const { message } = refusal(deep);
    expect(message).toBe("insert: document value at d.d.d.d.….d.d.d.leaf is NaN");
  });

  test("keeps a path at the edge length whole", () => {
    expect(
      refusal({ a: { b: { c: { d: { e: { f: { g: { h: Number.NaN } } } } } } } }).message,
    ).toContain("a.b.c.d.e.f.g.h");
  });

  test("truncates a long key in the path", () => {
    const key = "k".repeat(10_000);
    const { message } = refusal({ [key]: Number.NaN });
    expect(message.length).toBeLessThan(200);
    expect(message).toContain(`["${"k".repeat(64)}"…]`);
  });
});

describe("assertInsertIdType", () => {
  test.each([undefined, "", "a"])("accepts %j", (id) => {
    expect(() => assertInsertIdType(id)).not.toThrow();
  });
  test.each([null, 42, -0, Number.NaN, true, {}, []])("refuses %j", (id) => {
    expect(() => assertInsertIdType(id)).toThrow(
      expect.objectContaining({ code: "InvalidConfig" }),
    );
  });
});
