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
