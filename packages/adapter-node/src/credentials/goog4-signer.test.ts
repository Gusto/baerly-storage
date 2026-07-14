import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  goog4CanonicalRequest,
  goog4Signer,
  goog4StringToSign,
  sigV4Signature,
} from "./goog4-signer.ts";

// SHA-256 of the empty body — a fixed, well-known value. Confirm against
// the docs; it is the hashed-payload for any GET / empty-body PUT.
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

describe("sigV4Signature (AWS-vector oracle — proves the shared signing core)", () => {
  // AWS publishes the aws-sig-v4-test-suite with a fixed key and a full .authz
  // (Signature=) per case. GOOG4 is this core with four substituted constants,
  // so reproducing AWS's signature proves the canonical-request / string-to-sign
  // / key-chain / hex machinery in CI with zero infra — everything except the
  // four GOOG4 constants. Vendor the vector file(s) and assert against them; the
  // literal below is get-vanilla's published Signature — CONFIRM it against the
  // vendored `get-vanilla.authz` before trusting it.
  const AWS_SECRET = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";
  const AWS_DATE = "20150830T123600Z";
  const AWS_YMD = "20150830";
  const AWS_SCOPE = `${AWS_YMD}/us-east-1/service/aws4_request`;

  test("reproduces AWS get-vanilla's published Signature", async () => {
    const canonical = goog4CanonicalRequest({
      method: "GET",
      url: "https://example.amazonaws.com/",
      signedHeaders: { host: "example.amazonaws.com", "x-amz-date": AWS_DATE },
      hashedPayload: EMPTY_SHA256,
    });
    const sts = await goog4StringToSign({
      algorithm: "AWS4-HMAC-SHA256",
      amzDate: AWS_DATE,
      scope: AWS_SCOPE,
      canonicalRequest: canonical,
    });
    const signature = await sigV4Signature({
      keyPrefix: "AWS4",
      terminator: "aws4_request",
      service: "service",
      region: "us-east-1",
      secretAccessKey: AWS_SECRET,
      yyyymmdd: AWS_YMD,
      stringToSign: sts,
    });
    // From aws-sig-v4-test-suite/get-vanilla/get-vanilla.authz.
    expect(signature).toBe("5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31");
  });

  // Query-canonicalization vector: proves goog4CanonicalRequest sorts by the
  // ENCODED query key (not source order) — get-vanilla-query-order-key-case's
  // request line is `GET /?Param2=value2&Param1=value1` but its .creq puts
  // Param1 before Param2. Source: the published aws-sig-v4-test-suite, vendored
  // at https://github.com/mongodb/libmongocrypt/tree/master/kms-message/aws-sig-v4-test-suite/get-vanilla-query-order-key-case
  // (.req / .creq / .sts / .authz fetched verbatim from that mirror on
  // 2026-07-14; Signature= below is copied unmodified from the .authz file —
  // not self-derived).
  test("reproduces AWS get-vanilla-query-order-key-case's published Signature", async () => {
    const canonical = goog4CanonicalRequest({
      method: "GET",
      url: "https://example.amazonaws.com/?Param2=value2&Param1=value1",
      signedHeaders: { host: "example.amazonaws.com", "x-amz-date": AWS_DATE },
      hashedPayload: EMPTY_SHA256,
    });
    // From the case's .creq — proves query pairs are re-sorted by encoded key.
    expect(canonical).toBe(
      [
        "GET",
        "/",
        "Param1=value1&Param2=value2",
        "host:example.amazonaws.com",
        `x-amz-date:${AWS_DATE}`,
        "",
        "host;x-amz-date",
        EMPTY_SHA256,
      ].join("\n"),
    );
    const sts = await goog4StringToSign({
      algorithm: "AWS4-HMAC-SHA256",
      amzDate: AWS_DATE,
      scope: AWS_SCOPE,
      canonicalRequest: canonical,
    });
    const signature = await sigV4Signature({
      keyPrefix: "AWS4",
      terminator: "aws4_request",
      service: "service",
      region: "us-east-1",
      secretAccessKey: AWS_SECRET,
      yyyymmdd: AWS_YMD,
      stringToSign: sts,
    });
    // From get-vanilla-query-order-key-case.authz (Credential=AKIDEXAMPLE/...).
    expect(signature).toBe("b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500");
  });
});

describe("goog4CanonicalRequest query canonicalization (deterministic oracle-2)", () => {
  // Locks the #1 fix directly: repeated keys must all survive (not just the
  // first value `.get()` would return), and RFC-3986-strict encoding must
  // escape !'()* in addition to what encodeURIComponent already escapes.
  // Sort is by ENCODED key then ENCODED value, ascending.
  test("canonicalizes repeated keys and RFC-3986-strict-escaped special characters", () => {
    const canonical = goog4CanonicalRequest({
      method: "GET",
      url: "https://storage.googleapis.com/b/o?b=2&a=hello%20world&a=x%2Ay&c=%28p%29",
      signedHeaders: { host: "storage.googleapis.com" },
      hashedPayload: EMPTY_SHA256,
    });
    const query = canonical.split("\n")[2];
    expect(query).toBe("a=hello%20world&a=x%2Ay&b=2&c=%28p%29");
  });
});

describe("goog4CanonicalRequest (intermediate oracle)", () => {
  test("builds the documented canonical request for a bare GET", () => {
    const canonical = goog4CanonicalRequest({
      method: "GET",
      url: "https://storage.googleapis.com/example-bucket/cat.jpeg",
      signedHeaders: {
        host: "storage.googleapis.com",
        "x-goog-content-sha256": EMPTY_SHA256,
        "x-goog-date": "20250101T000000Z",
      },
      hashedPayload: EMPTY_SHA256,
    });
    // Canonical request = METHOD\nURI\nQUERY\nHEADERS\n\nSIGNED\nPAYLOADHASH,
    // headers sorted by lowercased name, each terminated by \n.
    expect(canonical).toBe(
      [
        "GET",
        "/example-bucket/cat.jpeg",
        "",
        "host:storage.googleapis.com",
        `x-goog-content-sha256:${EMPTY_SHA256}`,
        "x-goog-date:20250101T000000Z",
        "",
        "host;x-goog-content-sha256;x-goog-date",
        EMPTY_SHA256,
      ].join("\n"),
    );
  });

  // Mixed-case header names must canonicalize identically to their lowercase
  // form: GOOG4 lowercases header names, so the value lookup has to key off the
  // lowercased name too. A naive `signedHeaders[lowercased]` read against a
  // mixed-case record returns undefined and crashes on `.trim()`. The internal
  // caller always passes lowercase keys, but this function is exported.
  test("normalizes mixed-case header names to their lowercase canonical form", () => {
    const mixedCase = goog4CanonicalRequest({
      method: "GET",
      url: "https://storage.googleapis.com/example-bucket/cat.jpeg",
      signedHeaders: {
        Host: "storage.googleapis.com",
        "X-Goog-Content-Sha256": EMPTY_SHA256,
        "X-Goog-Date": "20250101T000000Z",
      },
      hashedPayload: EMPTY_SHA256,
    });
    const lowercase = goog4CanonicalRequest({
      method: "GET",
      url: "https://storage.googleapis.com/example-bucket/cat.jpeg",
      signedHeaders: {
        host: "storage.googleapis.com",
        "x-goog-content-sha256": EMPTY_SHA256,
        "x-goog-date": "20250101T000000Z",
      },
      hashedPayload: EMPTY_SHA256,
    });
    expect(mixedCase).toBe(lowercase);
  });

  // Guards the canonical-PATH fix: `URL.pathname` percent-encodes spaces but
  // leaves SigV4-reserved sub-delims (`+()` here) raw, which GOOG4 requires
  // encoded — otherwise an object key containing them signs differently from
  // what GCS computes server-side (403 SignatureDoesNotMatch). Also confirms
  // the already-percent-encoded space (`%20`) is left intact, not re-encoded
  // into `%2520` (the double-encoding failure mode of a naive re-encode fix).
  test("percent-encodes sub-delim path characters without double-encoding", () => {
    const canonical = goog4CanonicalRequest({
      method: "GET",
      url: "https://storage.googleapis.com/example-bucket/a+b (c).json",
      signedHeaders: {
        host: "storage.googleapis.com",
        "x-goog-content-sha256": EMPTY_SHA256,
        "x-goog-date": "20250101T000000Z",
      },
      hashedPayload: EMPTY_SHA256,
    });
    const lines = canonical.split("\n");
    expect(lines[1]).toBe("/example-bucket/a%2Bb%20%28c%29.json");
  });

  // GCS's enumerated canonical-path encode set includes `[` and `]`, which
  // `URL.pathname` leaves raw — unlike `^`, which `URL.pathname` already
  // encodes. A key carrying brackets would otherwise sign with raw `[]` while
  // GCS canonicalizes them to %5B/%5D server-side (403 SignatureDoesNotMatch).
  test("percent-encodes bracket characters GCS's canonical set requires", () => {
    const canonical = goog4CanonicalRequest({
      method: "GET",
      url: "https://storage.googleapis.com/example-bucket/a[0]^b.json",
      signedHeaders: { host: "storage.googleapis.com" },
      hashedPayload: EMPTY_SHA256,
    });
    const lines = canonical.split("\n");
    // `[` `]` → %5B %5D; `^` was already %5E via URL.pathname (not double-encoded).
    expect(lines[1]).toBe("/example-bucket/a%5B0%5D%5Eb.json");
  });
});

describe("goog4StringToSign (intermediate oracle)", () => {
  test("builds GOOG4-HMAC-SHA256 string-to-sign from a canonical request", async () => {
    const canonical = goog4CanonicalRequest({
      method: "GET",
      url: "https://storage.googleapis.com/example-bucket/cat.jpeg",
      signedHeaders: {
        host: "storage.googleapis.com",
        "x-goog-content-sha256": EMPTY_SHA256,
        "x-goog-date": "20250101T000000Z",
      },
      hashedPayload: EMPTY_SHA256,
    });
    const sts = await goog4StringToSign({
      algorithm: "GOOG4-HMAC-SHA256",
      amzDate: "20250101T000000Z",
      scope: "20250101/auto/storage/goog4_request",
      canonicalRequest: canonical,
    });
    const lines = sts.split("\n");
    expect(lines[0]).toBe("GOOG4-HMAC-SHA256");
    expect(lines[1]).toBe("20250101T000000Z");
    expect(lines[2]).toBe("20250101/auto/storage/goog4_request");
    // lines[3] is hex(SHA-256(canonicalRequest)) — 64 lowercase hex chars.
    expect(lines[3]).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("goog4Signer", () => {
  test("attaches a GOOG4-HMAC-SHA256 Authorization header with the right scope", async () => {
    const sign = goog4Signer({
      credentials: { accessKeyId: "GOOG_EXAMPLE_ID", secretAccessKey: "EXAMPLE_SECRET" },
      now: () => Date.parse("2025-01-01T00:00:00Z"),
    });
    const signed = await sign(
      new Request("https://storage.googleapis.com/example-bucket/cat.jpeg", { method: "GET" }),
    );
    const auth = signed.headers.get("Authorization")!;
    expect(auth).toContain("GOOG4-HMAC-SHA256 ");
    expect(auth).toContain("Credential=GOOG_EXAMPLE_ID/20250101/auto/storage/goog4_request");
    expect(auth).toContain("SignedHeaders=host;x-goog-content-sha256;x-goog-date");
    expect(auth).toMatch(/Signature=[0-9a-f]{64}$/);
    // The signer must set the signed headers it committed to.
    expect(signed.headers.get("x-goog-date")).toBe("20250101T000000Z");
    expect(signed.headers.get("x-goog-content-sha256")).toBe(EMPTY_SHA256);
  });

  test("resolves a CredentialsProvider on each sign()", async () => {
    let calls = 0;
    const sign = goog4Signer({
      credentials: async () => {
        calls += 1;
        return { accessKeyId: "GOOG_ID", secretAccessKey: "SECRET" };
      },
      now: () => Date.parse("2025-01-01T00:00:00Z"),
    });
    await sign(new Request("https://storage.googleapis.com/b/k", { method: "GET" }));
    await sign(new Request("https://storage.googleapis.com/b/k", { method: "GET" }));
    expect(calls).toBe(2);
  });

  // Load-bearing regression guard: the transport sets x-goog-if-generation-match
  // before signing, and GCS 403s any x-goog-* header not in SignedHeaders — which
  // would break EVERY conditional write (the whole commit path). A bodyless GET
  // would still pass, so this specifically exercises a header-carrying PUT.
  test("signs every x-goog-* header present, including x-goog-if-generation-match", async () => {
    const sign = goog4Signer({
      credentials: { accessKeyId: "GOOG_ID", secretAccessKey: "SECRET" },
      now: () => Date.parse("2025-01-01T00:00:00Z"),
    });
    const signed = await sign(
      new Request("https://storage.googleapis.com/example-bucket/log/1", {
        method: "PUT",
        headers: { "x-goog-if-generation-match": "0" },
      }),
    );
    const auth = signed.headers.get("Authorization")!;
    expect(auth).toMatch(/SignedHeaders=[^,]*x-goog-if-generation-match/);
  });

  // DELTA PROOF (oracle 3) — the live network call is gated; its captured
  // fixture is not (see the frozen vector below, signed with EXAMPLE
  // credentials rather than the real interop secret). Run this against the
  // real bucket in credentials/gcs.json to prove the four GOOG4 constants
  // are correct on the wire: a real GCS endpoint accepts the signature this
  // signer produces.
  test.skipIf(process.env["GCS_LIVE"] !== "1")(
    "live: a signed conditional PUT/GET against a real bucket returns 200 and a round-trippable generation",
    async () => {
      // Relative to the repo root (vitest's cwd) — same convention as
      // `tests/integration/conformance.test.ts`'s `loadCreds`.
      const raw = await readFile(join("credentials", "gcs.json"), "utf8");
      const config = JSON.parse(raw) as {
        endpoint: string;
        bucket: string;
        credentials: { accessKeyId: string; secretAccessKey: string };
      };
      const key = `goog4-signer-live-test/${randomUUID()}`;
      const url = `${config.endpoint}/${config.bucket}/${key}`;
      // Real wall-clock `now` (omit `now`) — GCS rejects skewed x-goog-date.
      const sign = goog4Signer({ credentials: config.credentials });

      const body = "goog4-signer live oracle";
      const putReq = await sign(
        new Request(url, {
          method: "PUT",
          headers: { "x-goog-if-generation-match": "0" },
          body,
        }),
      );
      const putRes = await fetch(putReq);
      expect(putRes.ok).toBe(true);
      const generation = putRes.headers.get("x-goog-generation");
      expect(generation).toBeTruthy();

      try {
        const getReq = await sign(new Request(url, { method: "GET" }));
        const getRes = await fetch(getReq);
        expect(getRes.ok).toBe(true);
        await expect(getRes.text()).resolves.toBe(body);
      } finally {
        const deleteReq = await sign(new Request(url, { method: "DELETE" }));
        await fetch(deleteReq);
      }
    },
  );

  // FROZEN VECTOR (CI-safe regression lock) — signs with EXAMPLE (non-secret)
  // credentials and a pinned `now`, then asserts the ENTIRE Authorization
  // header string against a literal captured from a first green run of this
  // signer. This locks all four GOOG4 constants (GOOG4 / goog4_request /
  // GOOG4-HMAC-SHA256 / storage) plus region "auto" against silent
  // regression, runs unconditionally in CI, and commits no secret. The live
  // oracle above is the proof that these constants are *correct* on the
  // wire; this test is the proof that they don't silently drift afterward.
  test("frozen vector: reproduces the full GOOG4 Authorization header (example creds)", async () => {
    const sign = goog4Signer({
      credentials: { accessKeyId: "GOOG_EXAMPLE_ID", secretAccessKey: "EXAMPLE_SECRET" },
      now: () => Date.parse("2025-01-01T00:00:00Z"),
    });
    const signed = await sign(
      new Request("https://storage.googleapis.com/example-bucket/cat.jpeg", { method: "GET" }),
    );
    expect(signed.headers.get("Authorization")).toBe(
      "GOOG4-HMAC-SHA256 Credential=GOOG_EXAMPLE_ID/20250101/auto/storage/goog4_request, SignedHeaders=host;x-goog-content-sha256;x-goog-date, Signature=ba07407abb494c7fb619c47fb3ce91aa2993a258a0fc958f20532eab523c8348",
    );
  });

  // CI-safe, no live gate: locks body handling — the signed Request must
  // still carry the original body, and the computed x-goog-content-sha256
  // must be the body's real hash, not the well-known empty-body constant
  // (which would silently pass if the signer hashed the wrong thing).
  test("preserves a non-empty body and hashes it (not the empty-body constant)", async () => {
    const sign = goog4Signer({
      credentials: { accessKeyId: "GOOG_ID", secretAccessKey: "SECRET" },
      now: () => Date.parse("2025-01-01T00:00:00Z"),
    });
    const body = "goog4-signer body-preservation fixture";
    const signed = await sign(
      new Request("https://storage.googleapis.com/example-bucket/log/1", {
        method: "PUT",
        body,
      }),
    );
    await expect(signed.clone().text()).resolves.toBe(body);
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)),
    );
    const expectedHash = [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(signed.headers.get("x-goog-content-sha256")).toBe(expectedHash);
    expect(signed.headers.get("x-goog-content-sha256")).not.toBe(EMPTY_SHA256);
  });
});
