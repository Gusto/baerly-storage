import { describe, expect, test } from "vitest";

import {
  BaerlyError,
  ERROR_CODES,
  RETRIABLE_CODES,
  isRetriableCode,
  type BaerlyErrorCode,
} from "./errors.ts";

describe("BaerlyError", () => {
  test("is an Error carrying name, code, and message", () => {
    const e = new BaerlyError("Conflict", "CAS lost");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("BaerlyError");
    expect(e.code).toBe("Conflict");
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

describe("retriable classification", () => {
  test("RETRIABLE_CODES is exactly {NetworkError, Conflict, WriteConflict}", () => {
    expect([...RETRIABLE_CODES].toSorted()).toEqual(["Conflict", "NetworkError", "WriteConflict"]);
  });

  test("every code's default retriable value", () => {
    const expected: Record<BaerlyErrorCode, boolean> = {
      InvalidConfig: false,
      NetworkError: true,
      AccessDenied: false,
      InvalidResponse: false,
      Internal: false,
      SchemaError: false,
      Conflict: true,
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
    expect(isRetriableCode("Conflict")).toBe(true);
    expect(isRetriableCode("SchemaError")).toBe(false);
    expect(isRetriableCode("NotFound")).toBe(false);
    expect(isRetriableCode("AmbiguousCommit")).toBe(false);
  });
  test("BaerlyError.retriable defaults from code", () => {
    expect(new BaerlyError("Conflict", "x").retriable).toBe(true);
    expect(new BaerlyError("NetworkError", "x").retriable).toBe(true);
    expect(new BaerlyError("SchemaError", "x").retriable).toBe(false);
  });

  test("BaerlyError.retriable can be overridden per instance", () => {
    expect(
      new BaerlyError(
        "Conflict",
        "duplicate _id",
        undefined,
        undefined,
        undefined,
        undefined,
        false,
      ).retriable,
    ).toBe(false);
    expect(
      new BaerlyError("SchemaError", "temporary", undefined, undefined, undefined, undefined, true)
        .retriable,
    ).toBe(true);
  });
});
