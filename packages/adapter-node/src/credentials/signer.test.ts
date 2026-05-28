import { describe, expect, test } from "vitest";
import { refreshingSigner } from "./signer.ts";

describe("refreshingSigner — static credentials", () => {
  test("signs a request with provided static credentials", async () => {
    const sign = refreshingSigner({
      region: "us-east-1",
      credentials: { accessKeyId: "AKIATEST", secretAccessKey: "secret123" },
    });
    const req = new Request("https://s3.us-east-1.amazonaws.com/bucket/key", {
      method: "GET",
    });
    const signed = await sign(req);
    expect(signed.headers.get("Authorization")).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIATEST\//);
  });

  test("includes x-amz-security-token header when sessionToken is provided", async () => {
    const sign = refreshingSigner({
      region: "us-east-1",
      credentials: {
        accessKeyId: "AKIATEST",
        secretAccessKey: "secret123",
        sessionToken: "TEMP-SESSION-TOKEN",
      },
    });
    const signed = await sign(new Request("https://s3.us-east-1.amazonaws.com/bucket/key"));
    expect(signed.headers.get("x-amz-security-token")).toBe("TEMP-SESSION-TOKEN");
  });
});

describe("refreshingSigner — provider with expiration", () => {
  test("calls provider once on first sign and reuses across calls before expiration", async () => {
    let calls = 0;
    const provider = async () => {
      calls += 1;
      return {
        accessKeyId: "ASIATEST",
        secretAccessKey: "secret",
        sessionToken: "tok1",
        expiration: new Date(1_000_000 + 3600_000), // 1h from t=1_000_000
      };
    };
    const sign = refreshingSigner({
      region: "us-east-1",
      credentials: provider,
      now: () => 1_000_000,
    });
    await sign(new Request("https://s3.us-east-1.amazonaws.com/b/k"));
    await sign(new Request("https://s3.us-east-1.amazonaws.com/b/k"));
    await sign(new Request("https://s3.us-east-1.amazonaws.com/b/k"));
    expect(calls).toBe(1);
  });

  test("refreshes when within 5min of expiration", async () => {
    let calls = 0;
    let currentTime = 1_000_000;
    const provider = async () => {
      calls += 1;
      return {
        accessKeyId: `ASIATEST${calls}`,
        secretAccessKey: "secret",
        expiration: new Date(currentTime + 3600_000),
      };
    };
    const sign = refreshingSigner({
      region: "us-east-1",
      credentials: provider,
      now: () => currentTime,
    });
    await sign(new Request("https://s3.us-east-1.amazonaws.com/b/k"));
    expect(calls).toBe(1);
    // jump to 4 min before original expiration — within 5-min buffer
    currentTime = 1_000_000 + 3600_000 - 4 * 60_000;
    await sign(new Request("https://s3.us-east-1.amazonaws.com/b/k"));
    expect(calls).toBe(2);
  });

  test("provider without expiration is called exactly once (treated as static)", async () => {
    let calls = 0;
    const provider = async () => {
      calls += 1;
      return { accessKeyId: "AKIATEST", secretAccessKey: "secret" };
    };
    const sign = refreshingSigner({
      region: "us-east-1",
      credentials: provider,
      now: () => 1_000_000,
    });
    await sign(new Request("https://s3.us-east-1.amazonaws.com/b/k"));
    await sign(new Request("https://s3.us-east-1.amazonaws.com/b/k"));
    expect(calls).toBe(1);
  });
});
