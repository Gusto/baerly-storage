/**
 * Unit tests for the provider sniffer in `./provider.ts`. Zero I/O.
 * Drives the detector through every URI / endpoint shape we
 * expect, plus the `--provider` override path.
 */

import { describe, expect, test } from "vitest";
import { detectProvider, pricingFor } from "./provider.ts";

describe("detectProvider", () => {
  test("file:// → dev", () => {
    expect(detectProvider({ bucketUri: "file:///tmp/baerly-x" })).toBe("dev");
  });

  test("memory:// → dev", () => {
    expect(detectProvider({ bucketUri: "memory://test-bucket" })).toBe("dev");
  });

  test("s3:// + R2 endpoint → r2", () => {
    expect(
      detectProvider({
        bucketUri: "s3://my-bucket",
        s3Endpoint: "https://abcdef.r2.cloudflarestorage.com",
      }),
    ).toBe("r2");
  });

  test("s3:// + AWS endpoint → aws-s3", () => {
    expect(
      detectProvider({
        bucketUri: "s3://my-bucket",
        s3Endpoint: "https://s3.us-east-1.amazonaws.com",
      }),
    ).toBe("aws-s3");
  });

  test("s3:// + no endpoint → aws-s3 (default)", () => {
    expect(detectProvider({ bucketUri: "s3://my-bucket" })).toBe("aws-s3");
  });

  test("s3:// + Minio endpoint → self-hosted", () => {
    expect(
      detectProvider({
        bucketUri: "s3://my-bucket",
        s3Endpoint: "http://localhost:9000",
      }),
    ).toBe("self-hosted");
  });

  test("s3:// + Backblaze endpoint → self-hosted (unrecognized provider)", () => {
    expect(
      detectProvider({
        bucketUri: "s3://my-bucket",
        s3Endpoint: "https://s3.us-west-001.backblazeb2.com",
      }),
    ).toBe("self-hosted");
  });

  test("override='r2' on a file:// URI → r2 (override wins)", () => {
    expect(detectProvider({ bucketUri: "file:///tmp/x", override: "r2" })).toBe("r2");
  });

  test("override='dev' on an s3:// URI → dev (operator opts out of $)", () => {
    expect(
      detectProvider({
        bucketUri: "s3://my-bucket",
        s3Endpoint: "https://x.r2.cloudflarestorage.com",
        override: "dev",
      }),
    ).toBe("dev");
  });
});

describe("pricingFor", () => {
  test("r2: 1M free Class A, $4.50/1M paid, 10 GB free storage", () => {
    const p = pricingFor("r2");
    expect(p.provider).toBe("r2");
    expect(p.freeClassAPerMonth).toBe(1_000_000);
    expect(p.usdPerMillionClassA).toBe(4.5);
    expect(p.freeStorageGb).toBe(10);
    expect(p.usdPerGbMonth).toBe(0.015);
  });

  test("aws-s3: no free tier (12-month new-account tier intentionally excluded)", () => {
    const p = pricingFor("aws-s3");
    expect(p.freeClassAPerMonth).toBe(0);
    expect(p.freeStorageGb).toBe(0);
    expect(p.usdPerMillionClassA).toBe(5);
    expect(p.usdPerGbMonth).toBe(0.023);
  });

  test("self-hosted: NaN dollar fields, 0 free tiers", () => {
    const p = pricingFor("self-hosted");
    expect(Number.isNaN(p.usdPerMillionClassA)).toBe(true);
    expect(Number.isNaN(p.usdPerGbMonth)).toBe(true);
    expect(p.freeClassAPerMonth).toBe(0);
  });

  test("dev: NaN dollar fields, 0 free tiers (same shape as self-hosted)", () => {
    const p = pricingFor("dev");
    expect(Number.isNaN(p.usdPerMillionClassA)).toBe(true);
    expect(Number.isNaN(p.usdPerGbMonth)).toBe(true);
  });
});
