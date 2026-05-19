import { BaerlyError } from "@baerly/protocol";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { bearerJwt, type JwksDocument } from "./bearer-jwt.ts";

const base64UrlEncode = (bytes: Uint8Array): string => {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]!);
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

const KID = "test-key-1";
const ISSUER = "https://idp.example.com/";
const AUDIENCE = "https://api.example.com/";

type SignFn = (
  payload: Record<string, unknown>,
  headerOverride?: Record<string, unknown>,
) => Promise<string>;

let signJwt: SignFn;
let jwks: JwksDocument;

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
  publicJwk["kid"] = KID;
  publicJwk["alg"] = "RS256";
  publicJwk["use"] = "sig";
  jwks = { keys: [publicJwk as { kty: string; kid: string }] };

  signJwt = async (payload, headerOverride) => {
    const header = { alg: "RS256", typ: "JWT", kid: KID, ...headerOverride };
    const headerB64 = base64UrlEncode(utf8(JSON.stringify(header)));
    const payloadB64 = base64UrlEncode(utf8(JSON.stringify(payload)));
    const signingInput = utf8(`${headerB64}.${payloadB64}`);
    // Allocate fresh ArrayBuffer to satisfy WebCrypto's BufferSource
    // contract under TS strict typing.
    const buf = new ArrayBuffer(signingInput.byteLength);
    new Uint8Array(buf).set(signingInput);
    const sig = new Uint8Array(
      await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, keyPair.privateKey, buf),
    );
    return `${headerB64}.${payloadB64}.${base64UrlEncode(sig)}`;
  };
});

const mkReq = (token: string | undefined, url = "https://api.example.com/v1/t/items"): Request =>
  new Request(url, {
    headers: token === undefined ? {} : { Authorization: `Bearer ${token}` },
  });

const validPayload = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  iss: ISSUER,
  aud: AUDIENCE,
  exp: Math.floor(Date.now() / 1000) + 600,
  nbf: Math.floor(Date.now() / 1000) - 10,
  tenant: "acme",
  sub: "user-1",
  ...overrides,
});

describe("bearerJwt — accept path", () => {
  test("verifies a well-formed JWT and returns the decoded payload as identity", async () => {
    const verifier = bearerJwt({ jwks, issuer: ISSUER, audience: AUDIENCE });
    const payload = validPayload();
    const token = await signJwt(payload);
    const res = await verifier(mkReq(token));
    expect(res).not.toBeNull();
    expect(res!.tenantPrefix).toBe("acme");
    expect(res!.identity).toMatchObject({ iss: ISSUER, aud: AUDIENCE, tenant: "acme" });
  });

  test("accepts JWT within clockSkewMs of expiry", async () => {
    const verifier = bearerJwt({ jwks, issuer: ISSUER, audience: AUDIENCE, clockSkewMs: 60_000 });
    // exp is 30 s in the past, but within the 60 s skew window.
    const token = await signJwt(validPayload({ exp: Math.floor(Date.now() / 1000) - 30 }));
    const res = await verifier(mkReq(token));
    expect(res).not.toBeNull();
  });

  test("audience may be an array containing the configured value", async () => {
    const verifier = bearerJwt({ jwks, issuer: ISSUER, audience: AUDIENCE });
    const token = await signJwt(validPayload({ aud: ["other", AUDIENCE] }));
    const res = await verifier(mkReq(token));
    expect(res).not.toBeNull();
  });
});

describe("bearerJwt — reject paths return null", () => {
  test("missing Authorization header → null", async () => {
    const verifier = bearerJwt({ jwks, issuer: ISSUER, audience: AUDIENCE });
    await expect(verifier(mkReq(undefined))).resolves.toBeNull();
  });

  test("non-Bearer auth scheme → null", async () => {
    const verifier = bearerJwt({ jwks, issuer: ISSUER, audience: AUDIENCE });
    const req = new Request("https://api.example.com/", {
      headers: { Authorization: "Basic dXNlcjpwYXNz" },
    });
    await expect(verifier(req)).resolves.toBeNull();
  });

  test("malformed JWT (not 3 segments) → null", async () => {
    const verifier = bearerJwt({ jwks, issuer: ISSUER, audience: AUDIENCE });
    await expect(verifier(mkReq("not.a.valid.jwt"))).resolves.toBeNull();
    await expect(verifier(mkReq("garbage"))).resolves.toBeNull();
  });

  test("alg: HS256 rejected before JWKS lookup (algorithm allowlist consulted first)", async () => {
    const verifier = bearerJwt({ jwks, issuer: ISSUER, audience: AUDIENCE });
    // Hand-craft a header claiming HS256; signature doesn't matter
    // because the algorithm check fires first.
    const headerB64 = base64UrlEncode(utf8(JSON.stringify({ alg: "HS256", kid: KID })));
    const payloadB64 = base64UrlEncode(utf8(JSON.stringify(validPayload())));
    const token = `${headerB64}.${payloadB64}.AAAA`;
    await expect(verifier(mkReq(token))).resolves.toBeNull();
  });

  test("expired JWT (past clockSkewMs slack) → null", async () => {
    const verifier = bearerJwt({ jwks, issuer: ISSUER, audience: AUDIENCE, clockSkewMs: 1_000 });
    const token = await signJwt(validPayload({ exp: Math.floor(Date.now() / 1000) - 600 }));
    await expect(verifier(mkReq(token))).resolves.toBeNull();
  });

  test("wrong issuer → null", async () => {
    const verifier = bearerJwt({ jwks, issuer: ISSUER, audience: AUDIENCE });
    const token = await signJwt(validPayload({ iss: "https://evil.example.com/" }));
    await expect(verifier(mkReq(token))).resolves.toBeNull();
  });

  test("wrong audience → null", async () => {
    const verifier = bearerJwt({ jwks, issuer: ISSUER, audience: AUDIENCE });
    const token = await signJwt(validPayload({ aud: "https://other-api.example.com/" }));
    await expect(verifier(mkReq(token))).resolves.toBeNull();
  });

  test("missing tenant claim → null", async () => {
    const verifier = bearerJwt({ jwks, issuer: ISSUER, audience: AUDIENCE });
    const payload = validPayload();
    delete (payload as Record<string, unknown>)["tenant"];
    const token = await signJwt(payload);
    await expect(verifier(mkReq(token))).resolves.toBeNull();
  });

  test('tenant claim containing "/" → null', async () => {
    const verifier = bearerJwt({ jwks, issuer: ISSUER, audience: AUDIENCE });
    const token = await signJwt(validPayload({ tenant: "a/b" }));
    await expect(verifier(mkReq(token))).resolves.toBeNull();
  });
});

describe("bearerJwt — JWKS cache", () => {
  test("first call fetches; second call within TTL hits cache (fetch invoked once)", async () => {
    const fetchStub = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify(jwks), { status: 200 }),
    );
    const verifier = bearerJwt({
      jwks: "https://idp.example.com/.well-known/jwks.json",
      issuer: ISSUER,
      audience: AUDIENCE,
      fetch: fetchStub,
    });
    const token = await signJwt(validPayload());
    await expect(verifier(mkReq(token))).resolves.not.toBeNull();
    await expect(verifier(mkReq(token))).resolves.not.toBeNull();
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  test("kid miss triggers one refresh; second miss inside rate-limit window does NOT refresh", async () => {
    const fetchStub = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify(jwks), { status: 200 }),
    );
    const verifier = bearerJwt({
      jwks: "https://idp.example.com/.well-known/jwks.json",
      issuer: ISSUER,
      audience: AUDIENCE,
      fetch: fetchStub,
    });
    // First request warms the cache.
    const okToken = await signJwt(validPayload());
    await expect(verifier(mkReq(okToken))).resolves.not.toBeNull();
    expect(fetchStub).toHaveBeenCalledTimes(1);

    // Request with an unknown kid → triggers ONE refresh attempt.
    const unknownKidToken = await signJwt(validPayload(), { kid: "unknown-kid-1" });
    await expect(verifier(mkReq(unknownKidToken))).resolves.toBeNull();
    expect(fetchStub).toHaveBeenCalledTimes(2);

    // Second request with a different unknown kid inside the rate
    // limit must NOT refresh again.
    const unknownKidToken2 = await signJwt(validPayload(), { kid: "unknown-kid-2" });
    await expect(verifier(mkReq(unknownKidToken2))).resolves.toBeNull();
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });

  test("cold-cache JWKS fetch failure throws BaerlyError{NetworkError}", async () => {
    const fetchStub = vi.fn<typeof fetch>(async () => {
      throw new TypeError("network down");
    });
    const verifier = bearerJwt({
      jwks: "https://idp.example.com/.well-known/jwks.json",
      issuer: ISSUER,
      audience: AUDIENCE,
      fetch: fetchStub,
    });
    const token = await signJwt(validPayload());
    try {
      await verifier(mkReq(token));
      expect.fail("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(BaerlyError);
      expect((error as BaerlyError).code).toBe("NetworkError");
    }
  });
});

describe("bearerJwt — config validation", () => {
  test("throws BaerlyError{InvalidConfig} on empty issuer", () => {
    expect(() => bearerJwt({ jwks, issuer: "", audience: AUDIENCE })).toThrow(BaerlyError);
  });

  test("throws BaerlyError{InvalidConfig} on empty audience", () => {
    expect(() => bearerJwt({ jwks, issuer: ISSUER, audience: "" })).toThrow(BaerlyError);
  });

  test("throws BaerlyError{InvalidConfig} on empty algorithms", () => {
    expect(() => bearerJwt({ jwks, issuer: ISSUER, audience: AUDIENCE, algorithms: [] })).toThrow(
      BaerlyError,
    );
  });
});

describe("bearerJwt — idempotence", () => {
  test("two verifier(req) calls on the same Request invoke fetch at most once", async () => {
    const fetchStub = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify(jwks), { status: 200 }),
    );
    const verifier = bearerJwt({
      jwks: "https://idp.example.com/.well-known/jwks.json",
      issuer: ISSUER,
      audience: AUDIENCE,
      fetch: fetchStub,
    });
    const token = await signJwt(validPayload());
    const req = mkReq(token);
    const a = await verifier(req);
    const b = await verifier(req);
    expect(a).toEqual(b);
    // Cache warms on first call; second call's `ensureFresh`
    // short-circuits on the warm TTL. Fetch fires at most once total.
    expect(fetchStub.mock.calls.length).toBeLessThanOrEqual(1);
  });
});
