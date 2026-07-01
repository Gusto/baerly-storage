import { afterEach, describe, expect, test, vi } from "vitest";
import { fromEks } from "./from-eks.ts";

const POD_IDENTITY_RESPONSE = JSON.stringify({
  AccessKeyId: "ASIAPODIDENTITY",
  SecretAccessKey: "secret-pod",
  Token: "token-pod",
  Expiration: "2026-05-28T18:00:00Z",
});

const STS_RESPONSE = `<AssumeRoleWithWebIdentityResponse>
  <AssumeRoleWithWebIdentityResult><Credentials>
    <AccessKeyId>ASIAWEBIDENTITY</AccessKeyId>
    <SecretAccessKey>secret-web</SecretAccessKey>
    <SessionToken>token-web</SessionToken>
    <Expiration>2026-05-28T18:00:00Z</Expiration>
  </Credentials></AssumeRoleWithWebIdentityResult>
</AssumeRoleWithWebIdentityResponse>`;

describe("fromEks", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("routes to EKS Pod Identity when AWS_CONTAINER_CREDENTIALS_FULL_URI is set", async () => {
    vi.stubEnv("AWS_CONTAINER_CREDENTIALS_FULL_URI", "http://169.254.170.23/v1/credentials");
    vi.stubEnv("AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE", "/var/run/secrets/token");
    const fakeFetch = vi.fn<typeof fetch>(
      async () => new Response(POD_IDENTITY_RESPONSE, { status: 200 }),
    );

    const creds = await fromEks({ fetch: fakeFetch, readFile: async () => "tok" })();

    // The Pod Identity mock's distinct key proves the router delegated there;
    // fromEksPodIdentity's own test owns the GET/endpoint wire assertions.
    expect(creds.accessKeyId).toBe("ASIAPODIDENTITY");
  });

  test("falls back to IRSA web-identity when only AWS_WEB_IDENTITY_TOKEN_FILE is set", async () => {
    vi.stubEnv("AWS_ROLE_ARN", "arn:aws:iam::123456789012:role/holler");
    vi.stubEnv("AWS_WEB_IDENTITY_TOKEN_FILE", "/var/run/secrets/token");
    vi.stubEnv("AWS_REGION", "us-west-2");
    const fakeFetch = vi.fn<typeof fetch>(async () => new Response(STS_RESPONSE, { status: 200 }));

    const creds = await fromEks({ fetch: fakeFetch, readFile: async () => "tok" })();

    // The web-identity mock's distinct key proves the router delegated there;
    // fromWebIdentity's own test owns the POST/STS-endpoint wire assertions.
    expect(creds.accessKeyId).toBe("ASIAWEBIDENTITY");
  });

  test("prefers Pod Identity when both mechanisms' env vars are present", async () => {
    vi.stubEnv("AWS_CONTAINER_CREDENTIALS_FULL_URI", "http://169.254.170.23/v1/credentials");
    vi.stubEnv("AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE", "/var/run/secrets/token");
    vi.stubEnv("AWS_ROLE_ARN", "arn:aws:iam::123456789012:role/holler");
    vi.stubEnv("AWS_WEB_IDENTITY_TOKEN_FILE", "/var/run/secrets/token");
    const fakeFetch = vi.fn<typeof fetch>(
      async () => new Response(POD_IDENTITY_RESPONSE, { status: 200 }),
    );

    const creds = await fromEks({ fetch: fakeFetch, readFile: async () => "tok" })();
    // Pod Identity wins the tie — its distinct key confirms which branch ran.
    expect(creds.accessKeyId).toBe("ASIAPODIDENTITY");
  });

  test("throws InvalidConfig when neither mechanism's env vars are present", async () => {
    vi.stubEnv("AWS_CONTAINER_CREDENTIALS_FULL_URI", "");
    vi.stubEnv("AWS_WEB_IDENTITY_TOKEN_FILE", "");
    await expect(fromEks()()).rejects.toMatchObject({ code: "InvalidConfig" });
  });
});
