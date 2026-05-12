import { AwsClient } from "aws4fetch";
import { BaerlyError } from "@baerly/protocol";
import { describe, expect, test } from "vitest";
import { awsIamSigV4 } from "./aws-iam-sigv4";

const ACCESS_KEY_ID = "AKIDEXAMPLE";
const SECRET_ACCESS_KEY = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";
const REGION = "us-east-1";
const SERVICE = "execute-api";

const makeClient = (overrides: Partial<ConstructorParameters<typeof AwsClient>[0]> = {}) =>
  new AwsClient({
    accessKeyId: ACCESS_KEY_ID,
    secretAccessKey: SECRET_ACCESS_KEY,
    region: REGION,
    service: SERVICE,
    ...overrides,
  });

const mkVerifier = () =>
  awsIamSigV4({
    principals: [
      {
        accessKeyId: ACCESS_KEY_ID,
        secretAccessKey: SECRET_ACCESS_KEY,
        tenantPrefix: "internal",
      },
    ],
    service: SERVICE,
    region: REGION,
  });

describe("awsIamSigV4 — accept path", () => {
  test("verifies an aws4fetch-signed GET request", async () => {
    const aws = makeClient();
    const unsigned = new Request("https://api.example.com/v1/t/items?limit=10", {
      method: "GET",
    });
    const signed = await aws.sign(unsigned);
    const res = await mkVerifier()(signed);
    expect(res).not.toBeNull();
    expect(res!.tenantPrefix).toBe("internal");
    expect(res!.identity).toEqual({ accessKeyId: ACCESS_KEY_ID });
  });

  test("verifies a signed POST with a JSON body", async () => {
    const aws = makeClient();
    const unsigned = new Request("https://api.example.com/v1/t/items", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    });
    const signed = await aws.sign(unsigned);
    const res = await mkVerifier()(signed);
    expect(res).not.toBeNull();
  });

  test("identity override is used when the principal carries one", async () => {
    const verifier = awsIamSigV4({
      principals: [
        {
          accessKeyId: ACCESS_KEY_ID,
          secretAccessKey: SECRET_ACCESS_KEY,
          tenantPrefix: "internal",
          identity: { kind: "iam", role: "svc-a" },
        },
      ],
      service: SERVICE,
      region: REGION,
    });
    const aws = makeClient();
    const signed = await aws.sign(new Request("https://api.example.com/", { method: "GET" }));
    const res = await verifier(signed);
    expect(res!.identity).toEqual({ kind: "iam", role: "svc-a" });
  });
});

describe("awsIamSigV4 — reject paths return null", () => {
  test("missing Authorization header → null", async () => {
    const res = await mkVerifier()(new Request("https://api.example.com/", { method: "GET" }));
    expect(res).toBeNull();
  });

  test("Authorization header that isn't SigV4 → null", async () => {
    const req = new Request("https://api.example.com/", {
      headers: { Authorization: "Bearer not-a-sigv4-cred" },
    });
    expect(await mkVerifier()(req)).toBeNull();
  });

  test("unknown accessKeyId → null", async () => {
    const aws = makeClient({ accessKeyId: "AKIDOTHER" });
    const signed = await aws.sign(new Request("https://api.example.com/", { method: "GET" }));
    expect(await mkVerifier()(signed)).toBeNull();
  });

  test("scope's service mismatch → null", async () => {
    const aws = makeClient({ service: "s3" });
    const signed = await aws.sign(new Request("https://api.example.com/", { method: "GET" }));
    expect(await mkVerifier()(signed)).toBeNull();
  });

  test("scope's region mismatch → null", async () => {
    const aws = makeClient({ region: "eu-west-1" });
    const signed = await aws.sign(new Request("https://api.example.com/", { method: "GET" }));
    expect(await mkVerifier()(signed)).toBeNull();
  });

  test("X-Amz-Date outside clockSkewMs → null", async () => {
    const aws = makeClient();
    // Sign with an explicit timestamp 1 hour in the past — outside
    // the default 5 minute skew window.
    const old = new Date(Date.now() - 3_600_000).toISOString().replace(/[:-]|\.\d{3}/g, "");
    const signed = await aws.sign(new Request("https://api.example.com/", { method: "GET" }), {
      aws: { datetime: old },
    });
    expect(await mkVerifier()(signed)).toBeNull();
  });

  test("tampered body invalidates the signature → null", async () => {
    const aws = makeClient();
    const unsigned = new Request("https://api.example.com/v1/t/items", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    });
    const signed = await aws.sign(unsigned);
    // Re-issue the signed request with a different body but the same
    // Authorization header — verifier rehashes the body and finds the
    // signature no longer matches.
    const tampered = new Request(signed.url, {
      method: signed.method,
      headers: signed.headers,
      body: JSON.stringify({ hello: "tampered" }),
    });
    expect(await mkVerifier()(tampered)).toBeNull();
  });
});

describe("awsIamSigV4 — config validation", () => {
  test("throws BaerlyError{InvalidConfig} on empty principals", () => {
    try {
      awsIamSigV4({ principals: [] });
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(BaerlyError);
      expect((err as BaerlyError).code).toBe("InvalidConfig");
    }
  });

  test("throws BaerlyError{InvalidConfig} on duplicate accessKeyId", () => {
    expect(() =>
      awsIamSigV4({
        principals: [
          { accessKeyId: "K", secretAccessKey: "s1", tenantPrefix: "a" },
          { accessKeyId: "K", secretAccessKey: "s2", tenantPrefix: "b" },
        ],
      }),
    ).toThrow(BaerlyError);
  });

  test("throws BaerlyError{InvalidConfig} on principal with invalid tenantPrefix", () => {
    expect(() =>
      awsIamSigV4({
        principals: [{ accessKeyId: "K", secretAccessKey: "s", tenantPrefix: "" }],
      }),
    ).toThrow(BaerlyError);
    expect(() =>
      awsIamSigV4({
        principals: [{ accessKeyId: "K", secretAccessKey: "s", tenantPrefix: "a/b" }],
      }),
    ).toThrow(BaerlyError);
  });
});
