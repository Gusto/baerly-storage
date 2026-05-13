import { BaerlyError } from "@baerly/protocol";
import { describe, expect, test, vi } from "vitest";
import { mapError } from "./router";

describe("mapError", () => {
  test("BaerlyError surfaces with its own code, status, and message", () => {
    const err = new BaerlyError("NotFound", "No such row: doc-42");
    const { status, envelope } = mapError(err);
    expect(status).toBe(404);
    expect(envelope.error).toEqual({ code: "NotFound", message: "No such row: doc-42" });
  });

  test("unmapped BaerlyError code falls through to 500 with its own message", () => {
    const err = new BaerlyError("InvalidResponse", "GET k: missing ETag");
    const { status, envelope } = mapError(err);
    expect(status).toBe(500);
    expect(envelope.error).toEqual({ code: "InvalidResponse", message: "GET k: missing ETag" });
  });

  test("unknown thrown value is sanitized and logged to stderr", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const err = new TypeError("bucket=secret-prod path=/internal/keys.json");
      const { status, envelope } = mapError(err);
      expect(status).toBe(500);
      // No internal detail in the wire envelope.
      expect(envelope.error).toEqual({ code: "Internal", message: "internal error" });
      // Original error still reaches the server-side log.
      expect(spy).toHaveBeenCalledWith("[baerly] unhandled error:", err);
    } finally {
      spy.mockRestore();
    }
  });

  test("non-Error thrown value is sanitized identically", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { status, envelope } = mapError("naked string with /etc/secret");
      expect(status).toBe(500);
      expect(envelope.error).toEqual({ code: "Internal", message: "internal error" });
      expect(spy).toHaveBeenCalledWith(
        "[baerly] unhandled error:",
        "naked string with /etc/secret",
      );
    } finally {
      spy.mockRestore();
    }
  });
});
