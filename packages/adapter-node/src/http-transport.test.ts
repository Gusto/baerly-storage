import { describe, expect, test } from "vitest";
import { RETRY_AFTER_MAX_SECONDS } from "@baerly/protocol";
import { parseRetryAfter } from "./http-transport.ts";

// A fixed IMF-fixdate and its epoch (ms), so the HTTP-date branch can be
// exercised deterministically via the `now` injection point.
const HTTP_DATE = "Wed, 21 Oct 2015 07:28:00 GMT";
const HTTP_DATE_MS = Date.parse(HTTP_DATE);
const at = (offsetMs: number) => () => HTTP_DATE_MS + offsetMs;

describe("parseRetryAfter", () => {
  test("absent / blank headers → undefined", () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("")).toBeUndefined();
    expect(parseRetryAfter("   ")).toBeUndefined();
  });

  test("delta-seconds → the integer", () => {
    expect(parseRetryAfter("0")).toBe(0);
    expect(parseRetryAfter("5")).toBe(5);
  });

  test("delta-seconds above the ceiling clamp to RETRY_AFTER_MAX_SECONDS", () => {
    expect(parseRetryAfter(String(RETRY_AFTER_MAX_SECONDS + 60))).toBe(RETRY_AFTER_MAX_SECONDS);
  });

  test("non-integer numerics reject (V8's lenient Date.parse must not see them)", () => {
    // No alphabetic token, so the letter gate rejects before Date.parse.
    expect(parseRetryAfter("5.5")).toBeUndefined();
    expect(parseRetryAfter("-5")).toBeUndefined();
  });

  test("alphabetic garbage reaches Date.parse and rejects as NaN", () => {
    expect(parseRetryAfter("later please")).toBeUndefined();
  });

  test("HTTP-date in the future → ceil(seconds until then)", () => {
    // now is 10s before the header's instant.
    expect(parseRetryAfter(HTTP_DATE, at(-10_000))).toBe(10);
  });

  test("HTTP-date far in the future clamps to RETRY_AFTER_MAX_SECONDS", () => {
    expect(parseRetryAfter(HTTP_DATE, at(-600_000))).toBe(RETRY_AFTER_MAX_SECONDS);
  });

  test("HTTP-date in the past → 0", () => {
    // now is 5s after the header's instant.
    expect(parseRetryAfter(HTTP_DATE, at(5_000))).toBe(0);
  });
});
