import { BaerlyError } from "@baerly/protocol";
import { describe, expect, test } from "vitest";
import { allowlistIp, andAll } from "./allowlist-ip.ts";
import { sharedSecret } from "./shared-secret.ts";

const mkReq = (headers: Record<string, string> = {}): Request =>
  new Request("https://api.example.com/v1/t/items", { headers });

describe("allowlistIp — accept/reject", () => {
  test("accepts a request whose CF-Connecting-IP is inside a configured CIDR", async () => {
    const verifier = allowlistIp({
      cidrs: ["10.0.0.0/8", "192.168.1.0/24"],
      tenantPrefix: "internal",
    });
    const res = await verifier(mkReq({ "CF-Connecting-IP": "10.1.2.3" }));
    expect(res).not.toBeNull();
    expect(res!.tenantPrefix).toBe("internal");
  });

  test("rejects a request outside all CIDRs with null", async () => {
    const verifier = allowlistIp({
      cidrs: ["10.0.0.0/8"],
      tenantPrefix: "internal",
    });
    await expect(verifier(mkReq({ "CF-Connecting-IP": "8.8.8.8" }))).resolves.toBeNull();
  });

  test("rejects request with no IP header with null", async () => {
    const verifier = allowlistIp({
      cidrs: ["10.0.0.0/8"],
      tenantPrefix: "internal",
    });
    await expect(verifier(mkReq())).resolves.toBeNull();
  });

  test("X-Forwarded-For: a, b, c reads the leftmost IP", async () => {
    const verifier = allowlistIp({
      cidrs: ["10.0.0.0/8"],
      tenantPrefix: "internal",
      header: "X-Forwarded-For",
    });
    await expect(
      verifier(mkReq({ "X-Forwarded-For": "10.0.0.1, 192.0.2.1, 198.51.100.1" })),
    ).resolves.not.toBeNull();
    await expect(verifier(mkReq({ "X-Forwarded-For": "8.8.8.8, 10.0.0.1" }))).resolves.toBeNull();
  });

  test("IPv6 CIDR 2001:db8::/32 accepts 2001:db8::1", async () => {
    const verifier = allowlistIp({
      cidrs: ["2001:db8::/32"],
      tenantPrefix: "internal",
    });
    await expect(verifier(mkReq({ "CF-Connecting-IP": "2001:db8::1" }))).resolves.not.toBeNull();
    // Different family — IPv4 address against IPv6 CIDR should reject.
    await expect(verifier(mkReq({ "CF-Connecting-IP": "10.0.0.1" }))).resolves.toBeNull();
  });

  test("malformed IP in header → null", async () => {
    const verifier = allowlistIp({
      cidrs: ["10.0.0.0/8"],
      tenantPrefix: "internal",
    });
    await expect(verifier(mkReq({ "CF-Connecting-IP": "not-an-ip" }))).resolves.toBeNull();
  });
});

describe("allowlistIp — config validation", () => {
  test("throws BaerlyError{InvalidConfig} on empty cidrs", () => {
    try {
      allowlistIp({ cidrs: [], tenantPrefix: "internal" });
      expect.fail("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(BaerlyError);
      expect((error as BaerlyError).code).toBe("InvalidConfig");
    }
  });

  test("throws BaerlyError{InvalidConfig} on malformed CIDR", () => {
    expect(() => allowlistIp({ cidrs: ["not-a-cidr"], tenantPrefix: "internal" })).toThrow(
      BaerlyError,
    );
    expect(() => allowlistIp({ cidrs: ["10.0.0.0/99"], tenantPrefix: "internal" })).toThrow(
      BaerlyError,
    );
  });

  test("throws BaerlyError{InvalidConfig} on invalid tenantPrefix", () => {
    expect(() => allowlistIp({ cidrs: ["10.0.0.0/8"], tenantPrefix: "" })).toThrow(BaerlyError);
    expect(() => allowlistIp({ cidrs: ["10.0.0.0/8"], tenantPrefix: "a/b" })).toThrow(BaerlyError);
  });
});

describe("andAll composition", () => {
  test("rejects when allowlistIp blocks even with a valid secret", async () => {
    const verifier = andAll(
      allowlistIp({ cidrs: ["10.0.0.0/8"], tenantPrefix: "_" }),
      sharedSecret({ secret: "s3cret", tenantPrefix: "tenant" }),
    );
    const res = await verifier(
      mkReq({ "CF-Connecting-IP": "8.8.8.8", Authorization: "Bearer s3cret" }),
    );
    expect(res).toBeNull();
  });

  test("rejects when IP is allowed but secret is wrong", async () => {
    const verifier = andAll(
      allowlistIp({ cidrs: ["10.0.0.0/8"], tenantPrefix: "_" }),
      sharedSecret({ secret: "s3cret", tenantPrefix: "tenant" }),
    );
    const res = await verifier(
      mkReq({ "CF-Connecting-IP": "10.0.0.1", Authorization: "Bearer wrong" }),
    );
    expect(res).toBeNull();
  });

  test("accepts when both pass and returns the last verifier's tenantPrefix", async () => {
    const verifier = andAll(
      allowlistIp({ cidrs: ["10.0.0.0/8"], tenantPrefix: "_" }),
      sharedSecret({ secret: "s3cret", tenantPrefix: "tenant" }),
    );
    const res = await verifier(
      mkReq({ "CF-Connecting-IP": "10.0.0.1", Authorization: "Bearer s3cret" }),
    );
    expect(res).not.toBeNull();
    expect(res!.tenantPrefix).toBe("tenant");
  });

  test("throws BaerlyError{InvalidConfig} when called with zero verifiers", () => {
    expect(() => andAll()).toThrow(BaerlyError);
  });
});
