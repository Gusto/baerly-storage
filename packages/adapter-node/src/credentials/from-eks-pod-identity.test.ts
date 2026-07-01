import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fromEksPodIdentity } from "./from-eks-pod-identity.ts";

const AGENT_RESPONSE = JSON.stringify({
  AccessKeyId: "ASIATESTFROMEKS",
  SecretAccessKey: "secret-from-agent",
  Token: "session-token-from-agent",
  Expiration: "2026-05-28T18:00:00Z",
});

describe("fromEksPodIdentity", () => {
  beforeEach(() => {
    vi.stubEnv("AWS_CONTAINER_CREDENTIALS_FULL_URI", "http://169.254.170.23/v1/credentials");
    vi.stubEnv(
      "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
      "/var/run/secrets/eks.amazonaws.com/serviceaccount/token",
    );
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("reads token file, GETs agent endpoint with Authorization header, returns parsed creds with expiration", async () => {
    const fakeFetch = vi.fn<typeof fetch>(
      async () => new Response(AGENT_RESPONSE, { status: 200 }),
    );
    const fakeReadFile = vi.fn<(path: string, encoding: "utf8") => Promise<string>>(
      async () => "POD-IDENTITY-TOKEN\n",
    );

    const creds = await fromEksPodIdentity({ fetch: fakeFetch, readFile: fakeReadFile })();

    expect(fakeReadFile).toHaveBeenCalledWith(
      "/var/run/secrets/eks.amazonaws.com/serviceaccount/token",
      "utf8",
    );
    expect(fakeFetch).toHaveBeenCalledTimes(1);
    const [url, init] = fakeFetch.mock.calls[0]!;
    expect(url).toBe("http://169.254.170.23/v1/credentials");
    expect(init?.method).toBe("GET");
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.["Authorization"]).toBe("POD-IDENTITY-TOKEN");

    expect(creds).toEqual({
      accessKeyId: "ASIATESTFROMEKS",
      secretAccessKey: "secret-from-agent",
      sessionToken: "session-token-from-agent",
      expiration: new Date("2026-05-28T18:00:00Z"),
    });
  });

  test("throws InvalidConfig when AWS_CONTAINER_CREDENTIALS_FULL_URI is missing", async () => {
    vi.stubEnv("AWS_CONTAINER_CREDENTIALS_FULL_URI", "");
    await expect(fromEksPodIdentity()()).rejects.toMatchObject({ code: "InvalidConfig" });
  });

  test("throws InvalidConfig when AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE is missing", async () => {
    vi.stubEnv("AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE", "");
    await expect(fromEksPodIdentity()()).rejects.toMatchObject({ code: "InvalidConfig" });
  });

  test("surfaces agent 403 as AccessDenied", async () => {
    const fakeFetch = vi.fn<typeof fetch>(
      async () => new Response('{"message":"forbidden"}', { status: 403 }),
    );
    const fakeReadFile = vi.fn<(path: string, encoding: "utf8") => Promise<string>>(
      async () => "bad-token",
    );
    await expect(
      fromEksPodIdentity({ fetch: fakeFetch, readFile: fakeReadFile })(),
    ).rejects.toMatchObject({ code: "AccessDenied" });
  });

  test("surfaces 5xx as NetworkError (transient)", async () => {
    const fakeFetch = vi.fn<typeof fetch>(async () => new Response("agent busy", { status: 503 }));
    const fakeReadFile = vi.fn<(path: string, encoding: "utf8") => Promise<string>>(
      async () => "tok",
    );
    await expect(
      fromEksPodIdentity({ fetch: fakeFetch, readFile: fakeReadFile })(),
    ).rejects.toMatchObject({ code: "NetworkError" });
  });

  test("surfaces 429 throttling as NetworkError (retryable)", async () => {
    const fakeFetch = vi.fn<typeof fetch>(async () => new Response("throttled", { status: 429 }));
    const fakeReadFile = vi.fn<(path: string, encoding: "utf8") => Promise<string>>(
      async () => "tok",
    );
    await expect(
      fromEksPodIdentity({ fetch: fakeFetch, readFile: fakeReadFile })(),
    ).rejects.toMatchObject({ code: "NetworkError" });
  });

  test("surfaces malformed 200-body as InvalidResponse (parse failure)", async () => {
    const fakeFetch = vi.fn<typeof fetch>(
      async () =>
        new Response("not json at all <html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
    );
    const fakeReadFile = vi.fn<(path: string, encoding: "utf8") => Promise<string>>(
      async () => "tok",
    );
    await expect(
      fromEksPodIdentity({ fetch: fakeFetch, readFile: fakeReadFile })(),
    ).rejects.toMatchObject({ code: "InvalidResponse" });
  });

  test("wraps a token-file read failure in a BaerlyError (InvalidConfig)", async () => {
    const fakeReadFile = vi.fn<(path: string, encoding: "utf8") => Promise<string>>(async () => {
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    });
    await expect(
      fromEksPodIdentity({ fetch: vi.fn<typeof fetch>(), readFile: fakeReadFile })(),
    ).rejects.toMatchObject({ code: "InvalidConfig" });
  });

  test("throws InvalidConfig when the token file is empty or whitespace", async () => {
    const fakeFetch = vi.fn<typeof fetch>();
    await expect(
      fromEksPodIdentity({ fetch: fakeFetch, readFile: async () => "  \n" })(),
    ).rejects.toMatchObject({ code: "InvalidConfig" });
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  test("wraps a fetch exception (timeout / DNS / unreachable) as NetworkError", async () => {
    const fakeFetch = vi.fn<typeof fetch>(async () => {
      throw Object.assign(new Error("The operation was aborted due to timeout"), {
        name: "TimeoutError",
      });
    });
    const fakeReadFile = vi.fn<(path: string, encoding: "utf8") => Promise<string>>(
      async () => "tok",
    );
    await expect(
      fromEksPodIdentity({ fetch: fakeFetch, readFile: fakeReadFile })(),
    ).rejects.toMatchObject({
      code: "NetworkError",
      message: expect.stringContaining("agent fetch failed"),
    });
  });

  test("surfaces a malformed Expiration as InvalidResponse", async () => {
    const badExpiry = JSON.stringify({
      AccessKeyId: "ASIATESTFROMEKS",
      SecretAccessKey: "secret-from-agent",
      Token: "session-token-from-agent",
      Expiration: "not-a-date",
    });
    const fakeFetch = vi.fn<typeof fetch>(async () => new Response(badExpiry, { status: 200 }));
    const fakeReadFile = vi.fn<(path: string, encoding: "utf8") => Promise<string>>(
      async () => "tok",
    );
    await expect(
      fromEksPodIdentity({ fetch: fakeFetch, readFile: fakeReadFile })(),
    ).rejects.toMatchObject({ code: "InvalidResponse" });
  });

  test("passes AbortSignal.timeout and refuses redirects on the agent fetch", async () => {
    let capturedInit: RequestInit | undefined;
    const fakeFetch = vi.fn<typeof fetch>(async (_url, init) => {
      capturedInit = init;
      return new Response(AGENT_RESPONSE, { status: 200 });
    });
    const fakeReadFile = vi.fn<(path: string, encoding: "utf8") => Promise<string>>(
      async () => "tok",
    );
    await fromEksPodIdentity({ fetch: fakeFetch, readFile: fakeReadFile })();
    const signal = capturedInit?.signal as AbortSignal | undefined;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal!.aborted).toBe(false);
    // A redirect would resend the token (Authorization header) to the target.
    expect(capturedInit?.redirect).toBe("error");
  });
});
