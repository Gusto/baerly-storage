/* eslint-disable no-underscore-dangle -- `_id` is the locked primary-key
   field on document shapes; the test fixture asserts on it by name. */

/**
 * Unit-test coverage for the StandardSchemaV1 adapter
 * (`./schema.ts`). The fixture validator is hand-rolled — adding zod
 * (or any other library) as a devDep just to exercise `validateOrThrow`
 * would violate the repo's "no new runtime deps" rule even at the
 * test scope.
 */

import { describe, expect, test } from "vitest";
import { BaerlyError } from "@baerly/protocol";
import { type SchemaValidator, validateOrThrow } from "./schema.ts";

const stringIdSchema: SchemaValidator<{ _id: string }, { _id: string }> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (v) => {
      if (typeof v !== "object" || v === null) {
        return { issues: [{ message: "expected object" }] };
      }
      const o = v as Record<string, unknown>;
      if (typeof o["_id"] !== "string") {
        return { issues: [{ path: ["_id"], message: "expected string" }] };
      }
      return { value: o as { _id: string } };
    },
  },
};

describe("validateOrThrow", () => {
  test("returns output on success", async () => {
    const out = await validateOrThrow(
      stringIdSchema,
      { _id: "x" },
      {
        collection: "t",
        verb: "insert",
      },
    );
    expect(out).toEqual({ _id: "x" });
  });

  test("throws SchemaError with issues on failure", async () => {
    await expect(
      validateOrThrow(stringIdSchema, { _id: 42 }, { collection: "t", verb: "insert" }),
    ).rejects.toMatchObject({
      code: "SchemaError",
      issues: [{ path: ["_id"], message: "expected string" }],
    });
  });

  test("path is normalised to string-or-number on the wire", async () => {
    const sym = Symbol("k");
    const symSchema: SchemaValidator = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: () => ({ issues: [{ path: [sym, 0, "nested"], message: "x" }] }),
      },
    };
    try {
      await validateOrThrow(symSchema, {}, { collection: "t", verb: "insert" });
      throw new Error("unreachable");
    } catch (e) {
      expect((e as BaerlyError).issues?.[0]?.path).toEqual([String(sym), 0, "nested"]);
    }
  });

  test("awaits a Promise-returning validator (async path)", async () => {
    const asyncSchema: SchemaValidator<{ x: number }, { x: number }> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: async (v) => {
          if (typeof v !== "object" || v === null) {
            return { issues: [{ message: "expected object" }] };
          }
          const o = v as Record<string, unknown>;
          if (typeof o["x"] !== "number") {
            return { issues: [{ path: ["x"], message: "expected number" }] };
          }
          return { value: { x: o["x"] } };
        },
      },
    };
    const ok = await validateOrThrow(
      asyncSchema,
      { x: 7 },
      {
        collection: "t",
        verb: "update",
      },
    );
    expect(ok).toEqual({ x: 7 });
    await expect(
      validateOrThrow(asyncSchema, { x: "bad" }, { collection: "t", verb: "update" }),
    ).rejects.toMatchObject({ code: "SchemaError" });
  });

  test("error message names the collection + verb + first offender", async () => {
    let err: unknown;
    try {
      await validateOrThrow(
        stringIdSchema,
        { _id: 42 },
        {
          collection: "tickets",
          verb: "replace",
        },
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BaerlyError);
    expect((err as BaerlyError).message).toContain("tickets.replace");
    expect((err as BaerlyError).message).toContain("_id");
    expect((err as BaerlyError).message).toContain("expected string");
  });
});
