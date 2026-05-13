import { BaerlyError } from "@baerly/protocol";
import { describe, expect, test } from "vitest";
import { sharedSecret } from "./shared-secret.ts";

const mkReq = (headers: Record<string, string> = {}): Request =>
  new Request("https://example.com/v1/t/items", { headers });

describe("sharedSecret", () => {
  test("accepts a request with Authorization: Bearer <secret>", async () => {
    const verifier = sharedSecret({ secret: "s3cret", tenantPrefix: "acme" });
    const res = await verifier(mkReq({ Authorization: "Bearer s3cret" }));
    expect(res).toEqual({
      tenantPrefix: "acme",
      identity: { kind: "shared-secret" },
    });
  });

  test("rejects missing Authorization header with null", async () => {
    const verifier = sharedSecret({ secret: "s3cret", tenantPrefix: "acme" });
    expect(await verifier(mkReq())).toBeNull();
  });

  test("rejects wrong secret with null", async () => {
    const verifier = sharedSecret({ secret: "s3cret", tenantPrefix: "acme" });
    expect(await verifier(mkReq({ Authorization: "Bearer wrong" }))).toBeNull();
  });

  test("rejects bare 'Bearer' (no value) with null", async () => {
    const verifier = sharedSecret({ secret: "s3cret", tenantPrefix: "acme" });
    expect(await verifier(mkReq({ Authorization: "Bearer" }))).toBeNull();
  });

  test("rejects a header that is a prefix of the expected value (length-mismatch short-circuit)", async () => {
    // secret is "abcdef"; a header carrying "Bearer abc" matches the
    // expected prefix but has a different length — the constant-time
    // compare must reject before invoking the diff loop.
    const verifier = sharedSecret({ secret: "abcdef", tenantPrefix: "acme" });
    expect(await verifier(mkReq({ Authorization: "Bearer abc" }))).toBeNull();
  });

  test("throws BaerlyError{InvalidConfig} on empty secret", () => {
    try {
      sharedSecret({ secret: "", tenantPrefix: "acme" });
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(BaerlyError);
      expect((err as BaerlyError).code).toBe("InvalidConfig");
    }
  });

  test("throws BaerlyError{InvalidConfig} on empty tenantPrefix", () => {
    try {
      sharedSecret({ secret: "s3cret", tenantPrefix: "" });
      expect.fail("expected throw");
    } catch (err) {
      expect((err as BaerlyError).code).toBe("InvalidConfig");
    }
  });

  test("throws BaerlyError{InvalidConfig} on tenantPrefix containing /", () => {
    try {
      sharedSecret({ secret: "s3cret", tenantPrefix: "a/b" });
      expect.fail("expected throw");
    } catch (err) {
      expect((err as BaerlyError).code).toBe("InvalidConfig");
    }
  });

  test("idempotent — two consecutive calls on the same Request return equal results", async () => {
    const verifier = sharedSecret({ secret: "s3cret", tenantPrefix: "acme" });
    const req = mkReq({ Authorization: "Bearer s3cret" });
    const a = await verifier(req);
    const b = await verifier(req);
    expect(a).toEqual(b);
  });
});
