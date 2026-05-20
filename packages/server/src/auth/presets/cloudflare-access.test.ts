import { BaerlyError } from "@baerly/protocol";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { cloudflareAccess } from "./cloudflare-access.ts";

const TEAM_DOMAIN = "acme";
const AUDIENCE_TAG = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const ISSUER = `https://${TEAM_DOMAIN}.cloudflareaccess.com`;
const KID = "cf-key-1";

type SignFn = (payload: Record<string, unknown>) => Promise<string>;
let signJwt: SignFn;
let jwksBody: string;

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  const publicJwk = {
    ...(await exportJWK(publicKey)),
    kid: KID,
    alg: "RS256",
    use: "sig",
  };
  jwksBody = JSON.stringify({ keys: [publicJwk] });

  signJwt = async (payload) =>
    new SignJWT(payload)
      .setProtectedHeader({ alg: "RS256", kid: KID, typ: "JWT" })
      .sign(privateKey);
});

const validPayload = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  iss: ISSUER,
  aud: AUDIENCE_TAG,
  exp: Math.floor(Date.now() / 1000) + 600,
  tenant: "internal",
  email: "user@example.com",
  ...overrides,
});

const mkReq = (cfHeader: string | undefined): Request =>
  new Request("https://api.example.com/v1/t/items", {
    headers: cfHeader === undefined ? {} : { "Cf-Access-Jwt-Assertion": cfHeader },
  });

describe("cloudflareAccess", () => {
  test("accepts a CF-Access JWT in the Cf-Access-Jwt-Assertion header", async () => {
    const fetchStub = vi.fn<typeof fetch>(async () => new Response(jwksBody, { status: 200 }));
    const verifier = cloudflareAccess({
      teamDomain: TEAM_DOMAIN,
      audienceTag: AUDIENCE_TAG,
      fetch: fetchStub,
    });
    const token = await signJwt(validPayload());
    const res = await verifier(mkReq(token));
    expect(res).not.toBeNull();
    expect(res!.tenantPrefix).toBe("internal");
  });

  test("missing Cf-Access-Jwt-Assertion header → null (no JWKS fetch)", async () => {
    const fetchStub = vi.fn<typeof fetch>(async () => new Response(jwksBody, { status: 200 }));
    const verifier = cloudflareAccess({
      teamDomain: TEAM_DOMAIN,
      audienceTag: AUDIENCE_TAG,
      fetch: fetchStub,
    });
    await expect(verifier(mkReq(undefined))).resolves.toBeNull();
    expect(fetchStub).not.toHaveBeenCalled();
  });

  test("wrong audience tag in token → null", async () => {
    const fetchStub = vi.fn<typeof fetch>(async () => new Response(jwksBody, { status: 200 }));
    const verifier = cloudflareAccess({
      teamDomain: TEAM_DOMAIN,
      audienceTag: AUDIENCE_TAG,
      fetch: fetchStub,
    });
    const token = await signJwt(validPayload({ aud: "f".repeat(64) }));
    await expect(verifier(mkReq(token))).resolves.toBeNull();
  });

  test("expired CF-Access JWT → null (delegates exp/skew to bearerJwt)", async () => {
    const fetchStub = vi.fn<typeof fetch>(async () => new Response(jwksBody, { status: 200 }));
    const verifier = cloudflareAccess({
      teamDomain: TEAM_DOMAIN,
      audienceTag: AUDIENCE_TAG,
      fetch: fetchStub,
      clockSkewMs: 1_000,
    });
    const token = await signJwt(validPayload({ exp: Math.floor(Date.now() / 1000) - 600 }));
    await expect(verifier(mkReq(token))).resolves.toBeNull();
  });

  test("throws BaerlyError{InvalidConfig} on empty teamDomain", () => {
    try {
      cloudflareAccess({ teamDomain: "", audienceTag: AUDIENCE_TAG });
      expect.fail("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(BaerlyError);
      expect((error as BaerlyError).code).toBe("InvalidConfig");
    }
  });

  test("throws BaerlyError{InvalidConfig} on malformed audienceTag", () => {
    try {
      cloudflareAccess({ teamDomain: TEAM_DOMAIN, audienceTag: "not-hex" });
      expect.fail("expected throw");
    } catch (error) {
      expect((error as BaerlyError).code).toBe("InvalidConfig");
    }
    // 63 chars (one short)
    expect(() =>
      cloudflareAccess({ teamDomain: TEAM_DOMAIN, audienceTag: "a".repeat(63) }),
    ).toThrow(BaerlyError);
    // uppercase rejected
    expect(() =>
      cloudflareAccess({ teamDomain: TEAM_DOMAIN, audienceTag: "A".repeat(64) }),
    ).toThrow(BaerlyError);
  });
});
