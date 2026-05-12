import { BaerlyError } from "@baerly/protocol";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { cloudflareAccess } from "./cloudflare-access";

const TEAM_DOMAIN = "acme";
const AUDIENCE_TAG = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const ISSUER = `https://${TEAM_DOMAIN}.cloudflareaccess.com`;
const KID = "cf-key-1";

const base64UrlEncode = (bytes: Uint8Array): string => {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

type SignFn = (payload: Record<string, unknown>) => Promise<string>;
let signJwt: SignFn;
let jwksBody: string;

beforeAll(async () => {
  const keyPair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const publicJwk = (await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as Record<
    string,
    unknown
  >;
  publicJwk.kid = KID;
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";
  jwksBody = JSON.stringify({ keys: [publicJwk] });

  signJwt = async (payload) => {
    const header = { alg: "RS256", typ: "JWT", kid: KID };
    const headerB64 = base64UrlEncode(utf8(JSON.stringify(header)));
    const payloadB64 = base64UrlEncode(utf8(JSON.stringify(payload)));
    const signingInput = utf8(`${headerB64}.${payloadB64}`);
    const buf = new ArrayBuffer(signingInput.byteLength);
    new Uint8Array(buf).set(signingInput);
    const sig = new Uint8Array(
      await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, keyPair.privateKey, buf),
    );
    return `${headerB64}.${payloadB64}.${base64UrlEncode(sig)}`;
  };
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
    const fetchStub = vi.fn(async () => new Response(jwksBody, { status: 200 }));
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
    const fetchStub = vi.fn(async () => new Response(jwksBody, { status: 200 }));
    const verifier = cloudflareAccess({
      teamDomain: TEAM_DOMAIN,
      audienceTag: AUDIENCE_TAG,
      fetch: fetchStub,
    });
    expect(await verifier(mkReq(undefined))).toBeNull();
    expect(fetchStub).not.toHaveBeenCalled();
  });

  test("wrong audience tag in token → null", async () => {
    const fetchStub = vi.fn(async () => new Response(jwksBody, { status: 200 }));
    const verifier = cloudflareAccess({
      teamDomain: TEAM_DOMAIN,
      audienceTag: AUDIENCE_TAG,
      fetch: fetchStub,
    });
    const token = await signJwt(validPayload({ aud: "f".repeat(64) }));
    expect(await verifier(mkReq(token))).toBeNull();
  });

  test("expired CF-Access JWT → null (delegates exp/skew to bearerJwt)", async () => {
    const fetchStub = vi.fn(async () => new Response(jwksBody, { status: 200 }));
    const verifier = cloudflareAccess({
      teamDomain: TEAM_DOMAIN,
      audienceTag: AUDIENCE_TAG,
      fetch: fetchStub,
      clockSkewMs: 1_000,
    });
    const token = await signJwt(validPayload({ exp: Math.floor(Date.now() / 1000) - 600 }));
    expect(await verifier(mkReq(token))).toBeNull();
  });

  test("throws BaerlyError{InvalidConfig} on empty teamDomain", () => {
    try {
      cloudflareAccess({ teamDomain: "", audienceTag: AUDIENCE_TAG });
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(BaerlyError);
      expect((err as BaerlyError).code).toBe("InvalidConfig");
    }
  });

  test("throws BaerlyError{InvalidConfig} on malformed audienceTag", () => {
    try {
      cloudflareAccess({ teamDomain: TEAM_DOMAIN, audienceTag: "not-hex" });
      expect.fail("expected throw");
    } catch (err) {
      expect((err as BaerlyError).code).toBe("InvalidConfig");
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
