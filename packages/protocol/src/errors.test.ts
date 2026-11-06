import { describe, expect, test } from "vitest";

import {
  BaerlyError,
  ERROR_CODES,
  RETRIABLE_CODES,
  isBaerlyErrorCode,
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
    expect(new BaerlyError("NetworkError", "boom", { cause }).cause).toBe(cause);
  });

  test("sets issues when provided", () => {
    const issues = [{ path: ["a"] as const, message: "required" }];
    const e = new BaerlyError("SchemaError", "bad", { issues });
    expect(e.issues).toEqual(issues);
  });

  test("leaves issues undefined when not provided", () => {
    const e = new BaerlyError("SchemaError", "bad");
    expect(e.issues).toBeUndefined();
  });

  test("sets status when provided", () => {
    const e = new BaerlyError("NotFound", "x", { status: 404 });
    expect(e.status).toBe(404);
  });

  test("leaves status undefined when not provided", () => {
    const e = new BaerlyError("NotFound", "x");
    expect(e.status).toBeUndefined();
  });

  test("sets resolution when provided", () => {
    const e = new BaerlyError("InvalidConfig", "bad", { resolution: "do X" });
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
      CapacityExceeded: false,
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
  test("isBaerlyErrorCode accepts exactly the known codes", () => {
    for (const code of ERROR_CODES) {
      expect(isBaerlyErrorCode(code)).toBe(true);
    }
    expect(isBaerlyErrorCode("Conflict")).toBe(false);
    expect(isBaerlyErrorCode(undefined)).toBe(false);
    expect(isBaerlyErrorCode(409)).toBe(false);
  });
  test("BaerlyError.retriable defaults from code", () => {
    expect(new BaerlyError("WriteConflict", "x").retriable).toBe(true);
    expect(new BaerlyError("NetworkError", "x").retriable).toBe(true);
    expect(new BaerlyError("SchemaError", "x").retriable).toBe(false);
  });

  test("BaerlyError has no per-instance way to set retriable", () => {
    // `retriable` is not an option; the options object has no such field.
    const err = new BaerlyError("WriteConflict", "lost race", {
      // @ts-expect-error -- `retriable` is not a BaerlyErrorOptions field
      retriable: false,
    });
    expect(err.retriable).toBe(true);
    // `retriable` is a getter-only prototype accessor, not an own field.
    expect(
      Object.getOwnPropertyDescriptor(BaerlyError.prototype, "retriable")?.set,
    ).toBeUndefined();
    expect(Object.hasOwn(err, "retriable")).toBe(false);
  });

  test("options land on the same-named properties; omitted ones are undefined", () => {
    const cause = new Error("root");
    const issues = [{ path: ["a", 0], message: "bad" }];
    const full = new BaerlyError("SchemaError", "m", {
      cause,
      issues,
      status: 400,
      resolution: "fix it",
      _id: "r1",
    });
    expect(full.cause).toBe(cause);
    expect(full.issues).toBe(issues);
    expect(full.status).toBe(400);
    expect(full.resolution).toBe("fix it");
    expect(full._id).toBe("r1");

    for (const bare of [
      new BaerlyError("Internal", "m"),
      new BaerlyError("Internal", "m", {}),
      new BaerlyError("Internal", "m", { issues: undefined, status: undefined }),
    ]) {
      expect(bare.cause).toBeUndefined();
      expect(bare.issues).toBeUndefined();
      expect(bare.status).toBeUndefined();
      expect(bare.resolution).toBeUndefined();
      expect(bare._id).toBeUndefined();
    }
  });

  test("the third argument is an options object, not a cause", () => {
    // @ts-expect-error -- an Error is not BaerlyErrorOptions; pass `{ cause: err }`
    void new BaerlyError("NetworkError", "m", new Error("root"));
    const typed: Error = new Error("root");
    // @ts-expect-error -- same for a variable typed Error
    void new BaerlyError("NetworkError", "m", typed);
    try {
      throw new Error("boom");
    } catch (error) {
      // @ts-expect-error -- a caught `unknown` is not BaerlyErrorOptions
      void new BaerlyError("NetworkError", "m", error);
    }
    // Untyped JavaScript still reaches the runtime: an Error in the options
    // slot is read as options, so only its own `.cause` is picked up, as with
    // native `new Error(msg, err)`.
    const inner = new Error("inner");
    const wrapped = new Error("root", { cause: inner });
    expect(new BaerlyError("NetworkError", "m", wrapped as never).cause).toBe(inner);
    expect(new BaerlyError("NetworkError", "m", typed as never).cause).toBeUndefined();
    expect(new BaerlyError("NetworkError", "m", { cause: typed }).cause).toBe(typed);
    // @ts-expect-error -- a string is not BaerlyErrorOptions
    void new BaerlyError("NetworkError", "m", "oops");
    // @ts-expect-error -- the old positional `issues` slot is gone
    void new BaerlyError("SchemaError", "m", undefined, []);
    // @ts-expect-error -- the old positional `_id` slot is gone
    void new BaerlyError("AmbiguousCommit", "m", undefined, undefined, undefined, undefined, "r");
  });

  test("a plain object in the options slot is read as options, not as a cause", () => {
    // A variable avoids the excess-property check, so this compiles: the
    // object shares `status` with the options. That is why a plain-object
    // cause must be wrapped as `{ cause: { ... } }`.
    const detail = { status: 503, notApplied: true };
    const misread = new BaerlyError("NetworkError", "m", detail);
    expect(misread.status).toBe(503);
    expect(misread.cause).toBeUndefined();
    expect(new BaerlyError("NetworkError", "m", { cause: detail }).cause).toBe(detail);
  });
});
