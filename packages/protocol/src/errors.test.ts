import { describe, expect, test } from "vitest";

import {
  BaerlyError,
  ERROR_CODES,
  RETRIABLE_CODES,
  isRetriableCode,
  isWriteConflict,
  type BaerlyErrorCode,
} from "./errors.ts";

describe("BaerlyError", () => {
  test("is an Error carrying name, code, and message", () => {
    const e = new BaerlyError("WriteConflict", "CAS lost");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("BaerlyError");
    expect(e.code).toBe("WriteConflict");
    expect(e.message).toBe("CAS lost");
  });

  test("threads cause through", () => {
    const cause = new Error("io");
    expect(new BaerlyError("NetworkError", "boom", cause).cause).toBe(cause);
  });

  test("sets issues when provided", () => {
    const issues = [{ path: ["a"] as const, message: "required" }];
    const e = new BaerlyError("SchemaError", "bad", undefined, issues);
    expect(e.issues).toEqual(issues);
  });

  test("leaves issues undefined when not provided", () => {
    const e = new BaerlyError("SchemaError", "bad");
    expect(e.issues).toBeUndefined();
  });

  test("sets status when provided", () => {
    const e = new BaerlyError("NotFound", "x", undefined, undefined, 404);
    expect(e.status).toBe(404);
  });

  test("leaves status undefined when not provided", () => {
    const e = new BaerlyError("NotFound", "x");
    expect(e.status).toBeUndefined();
  });

  test("sets resolution when provided", () => {
    const e = new BaerlyError("InvalidConfig", "bad", undefined, undefined, undefined, "do X");
    expect(e.resolution).toBe("do X");
  });

  test("leaves resolution undefined when not provided", () => {
    expect(new BaerlyError("InvalidConfig", "bad").resolution).toBeUndefined();
  });
});

describe("isWriteConflict", () => {
  test("matches WriteConflict only", () => {
    expect(isWriteConflict(new BaerlyError("WriteConflict", "x"))).toBe(true);
    expect(isWriteConflict(new BaerlyError("AlreadyExists", "x"))).toBe(false);
    expect(isWriteConflict(new BaerlyError("NetworkError", "x"))).toBe(false);
    expect(isWriteConflict(new Error("WriteConflict"))).toBe(false);
    expect(isWriteConflict(undefined)).toBe(false);
    expect(isWriteConflict("WriteConflict")).toBe(false);
  });

  test("matches by name and code, not class identity", () => {
    // A BaerlyError from a second loaded copy of this module, or one that
    // crossed a realm as JSON, fails `instanceof` but keeps name and code.
    const foreign = JSON.parse(JSON.stringify(new BaerlyError("WriteConflict", "x"))) as unknown;
    expect(foreign instanceof BaerlyError).toBe(false);
    expect(isWriteConflict(foreign)).toBe(true);
    expect(isWriteConflict({ name: "OtherError", code: "WriteConflict" })).toBe(false);
  });

  test("the false branch keeps every other code", () => {
    const e: BaerlyError = new BaerlyError("NetworkError", "x");
    if (isWriteConflict(e)) {
      throw new Error("unreachable");
    }
    // Type-checks only if the false branch did not narrow `e` to `never`.
    const code: BaerlyErrorCode = e.code;
    expect(code).toBe("NetworkError");
  });
});

describe("retriable classification", () => {
  test("RETRIABLE_CODES is exactly {NetworkError, WriteConflict}", () => {
    expect([...RETRIABLE_CODES].toSorted()).toEqual(["NetworkError", "WriteConflict"]);
  });

  test("every code's default retriable value", () => {
    const expected: Record<BaerlyErrorCode, boolean> = {
      InvalidConfig: false,
      NetworkError: true,
      AccessDenied: false,
      InvalidResponse: false,
      Internal: false,
      SchemaError: false,
      WriteConflict: true,
      AlreadyExists: false,
      AmbiguousCommit: false,
      Unauthorized: false,
      NotFound: false,
      PayloadTooLarge: false,
      UnsatisfiablePredicate: false,
      UseQueryAwaitedRecorder: false,
      UnexpectedWriteInQuery: false,
      MutationFailed: false,
    };
    const actual = Object.fromEntries(
      ERROR_CODES.map((code) => [code, new BaerlyError(code, "x").retriable]),
    );
    expect(actual).toEqual(expected);
  });
  test("isRetriableCode reflects the set", () => {
    expect(isRetriableCode("NetworkError")).toBe(true);
    expect(isRetriableCode("WriteConflict")).toBe(true);
    expect(isRetriableCode("AlreadyExists")).toBe(false);
    expect(isRetriableCode("SchemaError")).toBe(false);
    expect(isRetriableCode("NotFound")).toBe(false);
    expect(isRetriableCode("AmbiguousCommit")).toBe(false);
  });
  test("BaerlyError.retriable defaults from code", () => {
    expect(new BaerlyError("WriteConflict", "x").retriable).toBe(true);
    expect(new BaerlyError("NetworkError", "x").retriable).toBe(true);
    expect(new BaerlyError("SchemaError", "x").retriable).toBe(false);
  });

  test("BaerlyError has no per-instance way to set retriable", () => {
    // Slot 7 is `_id`; there is no eighth slot for a retriable override.
    const err = new BaerlyError(
      "WriteConflict",
      "lost race",
      undefined,
      undefined,
      undefined,
      undefined,
      "row-1",
      // @ts-expect-error -- the constructor takes at most seven arguments
      false,
    );
    expect(err._id).toBe("row-1");
    expect(err.retriable).toBe(true);
    // `retriable` is a getter-only prototype accessor, not an own field.
    expect(
      Object.getOwnPropertyDescriptor(BaerlyError.prototype, "retriable")?.set,
    ).toBeUndefined();
    expect(Object.hasOwn(err, "retriable")).toBe(false);
  });
});
