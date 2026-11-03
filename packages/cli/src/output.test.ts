import { ERROR_CODES, type BaerlyErrorCode } from "@baerly/protocol";
import { describe, expect, test } from "vitest";
import { errorToExitCode } from "./output.ts";

describe("errorToExitCode", () => {
  test("maps every BaerlyErrorCode to its exit class", () => {
    const expected: Record<BaerlyErrorCode, number> = {
      InvalidConfig: 1,
      NetworkError: 2,
      AccessDenied: 2,
      InvalidResponse: 3,
      Internal: 3,
      SchemaError: 2,
      WriteConflict: 3,
      AlreadyExists: 3,
      AmbiguousCommit: 3,
      Unauthorized: 2,
      NotFound: 2,
      PayloadTooLarge: 2,
      UnsatisfiablePredicate: 2,
      UseQueryAwaitedRecorder: 2,
      UnexpectedWriteInQuery: 2,
      MutationFailed: 2,
    };
    const actual = Object.fromEntries(ERROR_CODES.map((code) => [code, errorToExitCode(code)]));
    expect(actual).toEqual(expected);
  });
});
