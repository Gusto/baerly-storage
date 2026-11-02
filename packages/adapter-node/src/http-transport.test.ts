import { describe, expect, test } from "vitest";
import { BaerlyError, RETRY_AFTER_MAX_SECONDS } from "@baerly/protocol";
import { mapStorageError, parseRetryAfter, retry } from "./http-transport.ts";

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

describe("retry with conditionalCreate", () => {
  const sequence = (errors: readonly unknown[]) => {
    let calls = 0;
    const fn = async (): Promise<never> => {
      throw errors[Math.min(calls++, errors.length - 1)];
    };
    return { fn, calls: () => calls };
  };

  test("a first-attempt AccessDenied stays definitive", async () => {
    const { fn, calls } = sequence([new BaerlyError("AccessDenied", "403")]);
    await expect(retry(fn, { backoffMs: 0, conditionalCreate: true })).rejects.toMatchObject({
      code: "AccessDenied",
    });
    expect(calls()).toBe(1);
  });

  test("an AccessDenied after an uncertain attempt becomes NetworkError", async () => {
    const denied = new BaerlyError("AccessDenied", "403");
    const { fn } = sequence([new TypeError("ack lost"), denied]);
    const failure = await retry(fn, { backoffMs: 0, conditionalCreate: true }).catch(
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ code: "NetworkError", cause: denied });
  });

  test("a Conflict after an uncertain attempt stays Conflict", async () => {
    const { fn } = sequence([new TypeError("ack lost"), new BaerlyError("Conflict", "412")]);
    await expect(retry(fn, { backoffMs: 0, conditionalCreate: true })).rejects.toMatchObject({
      code: "Conflict",
    });
  });

  const throttled = () => new BaerlyError("NetworkError", "429", { status: 429, throttled: true });

  test("an all-throttled create reports notApplied", async () => {
    const { fn, calls } = sequence([throttled()]);
    const failure = await retry(fn, { retries: 2, backoffMs: 0, conditionalCreate: true }).catch(
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ code: "NetworkError", cause: { notApplied: true } });
    expect(calls()).toBe(3);
  });

  test("a throttle after an uncertain attempt does not report notApplied", async () => {
    const { fn } = sequence([new TypeError("ack lost"), throttled()]);
    const failure = await retry(fn, { retries: 1, backoffMs: 0, conditionalCreate: true }).catch(
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ code: "NetworkError" });
    expect((failure as BaerlyError).cause).not.toHaveProperty("notApplied");
  });

  test("an AccessDenied after only throttled attempts stays definitive", async () => {
    const { fn } = sequence([throttled(), new BaerlyError("AccessDenied", "403")]);
    await expect(retry(fn, { backoffMs: 0, conditionalCreate: true })).rejects.toMatchObject({
      code: "AccessDenied",
    });
  });

  test("without conditionalCreate an all-throttled call is unchanged", async () => {
    const { fn } = sequence([throttled()]);
    const failure = await retry(fn, { retries: 1, backoffMs: 0 }).catch((error: unknown) => error);
    expect((failure as BaerlyError).cause).not.toHaveProperty("notApplied");
  });

  test("without conditionalCreate a post-retry AccessDenied is unchanged", async () => {
    const { fn } = sequence([new TypeError("ack lost"), new BaerlyError("AccessDenied", "403")]);
    await expect(retry(fn, { backoffMs: 0 })).rejects.toMatchObject({ code: "AccessDenied" });
  });
});

describe("mapStorageError throttle tagging", () => {
  const slowDown =
    "<Error><Code>SlowDown</Code><Message>Please reduce your request rate.</Message></Error>";

  test.each([
    [429, "", true],
    [503, slowDown, true],
    [503, "<Error><Code>ServiceUnavailable</Code></Error>", false],
    [500, slowDown, false],
  ] as const)("status %i with body %j tags throttled: %s", async (status, body, expected) => {
    const error = await mapStorageError(new Response(body, { status }), "PUT", "k");
    expect(error).toMatchObject({ code: "NetworkError", cause: { status } });
    expect((error.cause as { throttled?: boolean }).throttled === true).toBe(expected);
  });
});
