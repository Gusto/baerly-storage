import { BaerlyError } from "@baerly/protocol";
import { AwsClient } from "aws4fetch";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  startS3WireEchoServer,
  type EchoServer,
} from "../../../tests/fixtures/s3-wire-echo-server.ts";
import { refreshingSigner } from "./credentials/signer.ts";
import { S3HttpStorage } from "./s3-http.ts";
import { sigV4Signer, type SigV4SignerOptions } from "./s3-signer.ts";

describe("sigV4Signer", () => {
  test("returns a signer that stamps an AWS4-HMAC-SHA256 Authorization header", async () => {
    const sign = sigV4Signer({
      accessKeyId: "AKIAEXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      region: "us-east-1",
    });
    const signed = await sign(
      new Request("https://s3.us-east-1.amazonaws.com/my-bucket/log/00000001", {
        method: "PUT",
        body: new Uint8Array([1, 2, 3]),
      }),
    );
    expect(signed.headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 /);
    expect(signed.headers.get("x-amz-content-sha256")).toBeTruthy();
  });

  test.each([
    ["empty accessKeyId", { accessKeyId: "", secretAccessKey: "secret", region: "auto" }],
    ["empty secretAccessKey", { accessKeyId: "AKIA", secretAccessKey: "", region: "auto" }],
    ["empty region", { accessKeyId: "AKIA", secretAccessKey: "secret", region: "" }],
    // Whitespace-only wrangler vars are truthy in JS but signing-blank in
    // effect — a `var` set to `" "` produces the same opaque 403 as one
    // left empty, so the guard trims before the emptiness check.
    ["whitespace accessKeyId", { accessKeyId: "  ", secretAccessKey: "secret", region: "auto" }],
    [
      "whitespace secretAccessKey",
      { accessKeyId: "AKIA", secretAccessKey: "\t\n", region: "auto" },
    ],
    ["whitespace region", { accessKeyId: "AKIA", secretAccessKey: "secret", region: "   " }],
    // A wrangler `var` (or process env key) that is declared *nowhere*
    // resolves to `undefined` at runtime — the `string | undefined` field
    // type mirrors the documented `env.AWS_ACCESS_KEY_ID` shape, so these
    // rows need no cast. The guard must fail-close on this (the most common
    // misconfig) with the same `InvalidConfig`, not let `.trim()` throw a raw
    // `TypeError` that is more opaque than the 403 it prevents.
    ["absent accessKeyId", { accessKeyId: undefined, secretAccessKey: "secret", region: "auto" }],
    ["absent secretAccessKey", { accessKeyId: "AKIA", secretAccessKey: undefined, region: "auto" }],
    ["absent region", { accessKeyId: "AKIA", secretAccessKey: "secret", region: undefined }],
  ] satisfies [string, SigV4SignerOptions][])(
    "throws InvalidConfig on %s rather than signing with blank credentials",
    (_label, opts) => {
      expect(() => sigV4Signer(opts)).toThrowError(BaerlyError);
      try {
        sigV4Signer(opts);
      } catch (error) {
        expect((error as BaerlyError).code).toBe("InvalidConfig");
      }
    },
  );

  test("trims whitespace-padded credentials before signing, not just for the guard", async () => {
    // A stray leading/trailing space (copy-paste artifact) must not reach the
    // signer: the Credential scope carries the trimmed access key id + region
    // verbatim, so padded values here would sign wrong and draw an opaque 403.
    const signed = await sigV4Signer({
      accessKeyId: "  AKIAEXAMPLE  ",
      secretAccessKey: "  secret  ",
      region: "  us-east-1  ",
    })(new Request("https://s3.us-east-1.amazonaws.com/b/k", { method: "GET" }));
    expect(signed.headers.get("authorization")).toMatch(
      /Credential=AKIAEXAMPLE\/\d{8}\/us-east-1\/s3\/aws4_request/,
    );
  });

  test("threads a session token through for temporary credentials", async () => {
    const sign = sigV4Signer({
      accessKeyId: "ASIAEXAMPLE",
      secretAccessKey: "secret",
      region: "auto",
      sessionToken: "FQoGZXIvYXdzEXANPLETOKEN",
    });
    const signed = await sign(new Request("https://s3.example.com/b/k", { method: "GET" }));
    expect(signed.headers.get("x-amz-security-token")).toBe("FQoGZXIvYXdzEXANPLETOKEN");
  });
});

// The S3 signers sign headers only (`UNSIGNED-PAYLOAD`) and never read the
// body. These tests pin what that must not change: the request still goes
// out with a `Content-Length` (AWS S3 `PutObject` rejects a plain chunked
// upload, Minio accepts one) and the `Authorization` is byte-identical to
// handing `aws4fetch` the whole request.
describe("S3 signers sign headers only", () => {
  const CREDS = {
    accessKeyId: "AKIAWIRETEST",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    sessionToken: "FQoGZXIvYXdzEXANPLETOKEN",
  };
  const REGION = "us-east-1";
  const FIXED_NOW = Date.parse("2026-01-01T00:00:00Z");
  const BODY_BYTES = 100_000;

  const signers: [string, () => (req: Request) => Promise<Request>][] = [
    ["sigV4Signer", () => sigV4Signer({ ...CREDS, region: REGION })],
    ["refreshingSigner (static)", () => refreshingSigner({ region: REGION, credentials: CREDS })],
    [
      "refreshingSigner (provider)",
      () => refreshingSigner({ region: REGION, credentials: async () => CREDS }),
    ],
  ];

  let server: EchoServer;
  beforeEach(async () => {
    server = await startS3WireEchoServer();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIXED_NOW);
  });
  afterEach(async () => {
    vi.useRealTimers();
    await server.close();
  });

  test.each(signers)(
    "%s: a PUT keeps Content-Length and the Authorization aws4fetch gives the full request",
    async (_label, makeSign) => {
      const storage = new S3HttpStorage({
        endpoint: server.origin,
        bucket: "wire",
        sign: makeSign(),
        retries: 0,
      });
      const body = new Uint8Array(BODY_BYTES).fill(7);
      await storage.put("log/00000001", body, {
        contentType: "application/json",
        ifNoneMatch: "*",
      });

      const seen = server.seen.get("/wire/log%2F00000001");
      expect(seen).toBeDefined();
      expect(seen!.contentLength).toBe(String(BODY_BYTES));
      expect(seen!.transferEncoding).toBeNull();
      expect(seen!.bytes).toBe(BODY_BYTES);
      expect(seen!.contentSha256).toBe("UNSIGNED-PAYLOAD");

      const expected = await new AwsClient({ ...CREDS, region: REGION, service: "s3" }).sign(
        new Request(`${server.origin}/wire/log%2F00000001`, {
          method: "PUT",
          headers: { "Content-Type": "application/json", "If-None-Match": "*" },
          body,
        }),
      );
      expect(seen!.authorization).toContain("Credential=AKIAWIRETEST/20260101/us-east-1/s3/");
      expect(seen!.authorization).toBe(expected.headers.get("authorization"));
    },
  );

  test.each(signers)("%s: signing does not clone the request body", async (_label, makeSign) => {
    const clone = vi.spyOn(Request.prototype, "clone");
    const signed = await makeSign()(
      new Request("https://s3.us-east-1.amazonaws.com/b/k", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: new Uint8Array(1024),
      }),
    );
    expect(clone).not.toHaveBeenCalled();
    const bytes = await signed.arrayBuffer();
    expect(bytes.byteLength).toBe(1024);
  });

  test.each(signers)(
    "%s: the signed request keeps the caller's abort signal",
    async (_label, makeSign) => {
      const controller = new AbortController();
      const signed = await makeSign()(
        new Request("https://s3.us-east-1.amazonaws.com/b/k", { signal: controller.signal }),
      );
      expect(signed.signal.aborted).toBe(false);
      controller.abort();
      expect(signed.signal.aborted).toBe(true);
    },
  );
});
