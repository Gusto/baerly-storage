import { BaerlyError } from "@baerly/protocol";
import { describe, expect, test } from "vitest";
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
