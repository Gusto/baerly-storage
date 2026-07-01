import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fromWebIdentity } from "./from-web-identity.ts";

// A realistic STS AssumeRoleWithWebIdentity success body (namespace attr is
// dropped by the parser's ignoreAttributes; extra result fields are ignored).
const STS_RESPONSE = `<?xml version="1.0" encoding="UTF-8"?>
<AssumeRoleWithWebIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">
  <AssumeRoleWithWebIdentityResult>
    <AssumedRoleUser>
      <Arn>arn:aws:sts::123456789012:assumed-role/holler/baerly-storage</Arn>
      <AssumedRoleId>AROAEXAMPLE:baerly-storage</AssumedRoleId>
    </AssumedRoleUser>
    <Credentials>
      <AccessKeyId>ASIATESTWEBID</AccessKeyId>
      <SecretAccessKey>secret-from-sts</SecretAccessKey>
      <SessionToken>session-token-from-sts</SessionToken>
      <Expiration>2026-05-28T18:00:00Z</Expiration>
    </Credentials>
  </AssumeRoleWithWebIdentityResult>
</AssumeRoleWithWebIdentityResponse>`;

describe("fromWebIdentity", () => {
  beforeEach(() => {
    vi.stubEnv("AWS_ROLE_ARN", "arn:aws:iam::123456789012:role/holler");
    vi.stubEnv(
      "AWS_WEB_IDENTITY_TOKEN_FILE",
      "/var/run/secrets/eks.amazonaws.com/serviceaccount/token",
    );
    vi.stubEnv("AWS_REGION", "us-west-2");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("reads token file, POSTs AssumeRoleWithWebIdentity to regional STS, returns parsed creds with expiration", async () => {
    const fakeFetch = vi.fn<typeof fetch>(async () => new Response(STS_RESPONSE, { status: 200 }));
    const fakeReadFile = vi.fn<(path: string, encoding: "utf8") => Promise<string>>(
      async () => "WEB-IDENTITY-JWT\n",
    );

    const creds = await fromWebIdentity({ fetch: fakeFetch, readFile: fakeReadFile })();

    expect(fakeReadFile).toHaveBeenCalledWith(
      "/var/run/secrets/eks.amazonaws.com/serviceaccount/token",
      "utf8",
    );
    expect(fakeFetch).toHaveBeenCalledTimes(1);
    const [url, init] = fakeFetch.mock.calls[0]!;
    expect(url).toBe("https://sts.us-west-2.amazonaws.com/");
    expect(init?.method).toBe("POST");
    const body = String(init?.body);
    expect(body).toContain("Action=AssumeRoleWithWebIdentity");
    expect(body).toContain("Version=2011-06-15");
    expect(body).toContain("RoleArn=arn%3Aaws%3Aiam%3A%3A123456789012%3Arole%2Fholler");
    // Token is trimmed of the trailing newline before signing.
    expect(body).toContain("WebIdentityToken=WEB-IDENTITY-JWT");

    expect(creds).toEqual({
      accessKeyId: "ASIATESTWEBID",
      secretAccessKey: "secret-from-sts",
      sessionToken: "session-token-from-sts",
      expiration: new Date("2026-05-28T18:00:00Z"),
    });
  });

  test("falls back to the global STS endpoint when no region is set", async () => {
    vi.stubEnv("AWS_REGION", "");
    vi.stubEnv("AWS_DEFAULT_REGION", "");
    const fakeFetch = vi.fn<typeof fetch>(async () => new Response(STS_RESPONSE, { status: 200 }));
    await fromWebIdentity({ fetch: fakeFetch, readFile: async () => "tok" })();
    expect(fakeFetch.mock.calls[0]![0]).toBe("https://sts.amazonaws.com/");
  });

  test("throws InvalidConfig when AWS_ROLE_ARN is missing", async () => {
    vi.stubEnv("AWS_ROLE_ARN", "");
    await expect(fromWebIdentity()()).rejects.toMatchObject({ code: "InvalidConfig" });
  });

  test("throws InvalidConfig when AWS_WEB_IDENTITY_TOKEN_FILE is missing", async () => {
    vi.stubEnv("AWS_WEB_IDENTITY_TOKEN_FILE", "");
    await expect(fromWebIdentity()()).rejects.toMatchObject({ code: "InvalidConfig" });
  });

  test("surfaces STS 403 as AccessDenied (permanent)", async () => {
    const fakeFetch = vi.fn<typeof fetch>(
      async () => new Response("<ErrorResponse/>", { status: 403 }),
    );
    await expect(
      fromWebIdentity({ fetch: fakeFetch, readFile: async () => "tok" })(),
    ).rejects.toMatchObject({ code: "AccessDenied" });
  });

  test("includes the STS error Code and Message in the thrown error", async () => {
    const stsError = `<ErrorResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">
      <Error>
        <Type>Sender</Type>
        <Code>InvalidIdentityToken</Code>
        <Message>The ID Token provided is not a valid JWT.</Message>
      </Error>
    </ErrorResponse>`;
    const fakeFetch = vi.fn<typeof fetch>(async () => new Response(stsError, { status: 400 }));
    await expect(
      fromWebIdentity({ fetch: fakeFetch, readFile: async () => "tok" })(),
    ).rejects.toMatchObject({
      code: "AccessDenied",
      message: expect.stringContaining("InvalidIdentityToken"),
    });
    await expect(
      fromWebIdentity({ fetch: fakeFetch, readFile: async () => "tok" })(),
    ).rejects.toMatchObject({
      message: expect.stringContaining("The ID Token provided is not a valid JWT."),
    });
  });

  test("wraps a token-file read failure in a BaerlyError (InvalidConfig)", async () => {
    const fakeReadFile = vi.fn<(path: string, encoding: "utf8") => Promise<string>>(async () => {
      throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
    });
    await expect(
      fromWebIdentity({ fetch: vi.fn<typeof fetch>(), readFile: fakeReadFile })(),
    ).rejects.toMatchObject({ code: "InvalidConfig" });
  });

  test("throws InvalidConfig when the token file is empty or whitespace", async () => {
    const fakeFetch = vi.fn<typeof fetch>();
    await expect(
      fromWebIdentity({ fetch: fakeFetch, readFile: async () => "   \n" })(),
    ).rejects.toMatchObject({ code: "InvalidConfig" });
    // Never reached STS — the empty token is caught before the fetch.
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  test("surfaces STS 5xx as NetworkError (transient)", async () => {
    const fakeFetch = vi.fn<typeof fetch>(async () => new Response("busy", { status: 503 }));
    await expect(
      fromWebIdentity({ fetch: fakeFetch, readFile: async () => "tok" })(),
    ).rejects.toMatchObject({ code: "NetworkError" });
  });

  test("surfaces STS 429 (throttling) as NetworkError (transient)", async () => {
    const fakeFetch = vi.fn<typeof fetch>(
      async () => new Response("<ErrorResponse/>", { status: 429 }),
    );
    await expect(
      fromWebIdentity({ fetch: fakeFetch, readFile: async () => "tok" })(),
    ).rejects.toMatchObject({ code: "NetworkError" });
  });

  test("passes AWS_ROLE_SESSION_NAME through to STS as RoleSessionName", async () => {
    vi.stubEnv("AWS_ROLE_SESSION_NAME", "holler-prod-42");
    const fakeFetch = vi.fn<typeof fetch>(async () => new Response(STS_RESPONSE, { status: 200 }));
    await fromWebIdentity({ fetch: fakeFetch, readFile: async () => "tok" })();
    expect(String(fakeFetch.mock.calls[0]![1]?.body)).toContain("RoleSessionName=holler-prod-42");
  });

  test("defaults RoleSessionName to baerly-storage when AWS_ROLE_SESSION_NAME is unset", async () => {
    vi.stubEnv("AWS_ROLE_SESSION_NAME", "");
    const fakeFetch = vi.fn<typeof fetch>(async () => new Response(STS_RESPONSE, { status: 200 }));
    await fromWebIdentity({ fetch: fakeFetch, readFile: async () => "tok" })();
    expect(String(fakeFetch.mock.calls[0]![1]?.body)).toContain("RoleSessionName=baerly-storage");
  });

  test("surfaces a malformed 200 body as InvalidResponse", async () => {
    const fakeFetch = vi.fn<typeof fetch>(async () => new Response("<nope/>", { status: 200 }));
    await expect(
      fromWebIdentity({ fetch: fakeFetch, readFile: async () => "tok" })(),
    ).rejects.toMatchObject({ code: "InvalidResponse" });
  });

  test("wraps a fetch exception (timeout / DNS / unreachable) as NetworkError", async () => {
    const fakeFetch = vi.fn<typeof fetch>(async () => {
      // AbortSignal.timeout rejects with a TimeoutError-shaped DOMException; a
      // DNS/connreset failure rejects with a TypeError. Either lands here.
      throw Object.assign(new Error("The operation was aborted due to timeout"), {
        name: "TimeoutError",
      });
    });
    await expect(
      fromWebIdentity({ fetch: fakeFetch, readFile: async () => "tok" })(),
    ).rejects.toMatchObject({
      code: "NetworkError",
      message: expect.stringContaining("STS fetch failed"),
    });
  });

  test("surfaces a non-ok STS response with an unparseable body as a bare-status error", async () => {
    // No <Error> element → parseStsError returns undefined → no (Code: …) detail.
    const fakeFetch = vi.fn<typeof fetch>(
      async () => new Response("upstream proxy timeout, not xml", { status: 400 }),
    );
    await expect(
      fromWebIdentity({ fetch: fakeFetch, readFile: async () => "tok" })(),
    ).rejects.toMatchObject({
      code: "AccessDenied",
      message: "fromWebIdentity: STS responded 400",
    });
  });

  test("surfaces a malformed Expiration as InvalidResponse", async () => {
    // A present-but-unparseable Expiration is as malformed as a missing one:
    // an Invalid Date would silently defeat the signer's refresh check.
    const badExpiry = STS_RESPONSE.replace("2026-05-28T18:00:00Z", "not-a-date");
    const fakeFetch = vi.fn<typeof fetch>(async () => new Response(badExpiry, { status: 200 }));
    await expect(
      fromWebIdentity({ fetch: fakeFetch, readFile: async () => "tok" })(),
    ).rejects.toMatchObject({ code: "InvalidResponse" });
  });

  test("passes AbortSignal.timeout and refuses redirects on the STS fetch", async () => {
    let capturedInit: RequestInit | undefined;
    const fakeFetch = vi.fn<typeof fetch>(async (_url, init) => {
      capturedInit = init;
      return new Response(STS_RESPONSE, { status: 200 });
    });
    await fromWebIdentity({ fetch: fakeFetch, readFile: async () => "tok" })();
    const signal = capturedInit?.signal as AbortSignal | undefined;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal!.aborted).toBe(false);
    // A redirect would resend the unsigned token body to the 3xx target.
    expect(capturedInit?.redirect).toBe("error");
  });
});
