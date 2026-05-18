import { describe, expect, it } from "vitest";
import { gcsStorage, minioStorage, r2Storage, s3Storage } from "./storage-factories.ts";

describe("storage factories", () => {
  // Each factory returns a `Storage` shape — the four kernel
  // methods are present as functions. We don't dispatch any HTTP
  // here; the conformance test exercises the wire.
  const sample = {
    accessKeyId: "AKIAEXAMPLE",
    secretAccessKey: "secret",
    bucket: "b",
  };

  for (const [name, build] of [
    ["s3Storage", () => s3Storage({ ...sample, region: "us-east-1" })],
    ["r2Storage", () => r2Storage({ ...sample, accountId: "acct" })],
    ["minioStorage", () => minioStorage({ ...sample, endpoint: "http://x" })],
    [
      "gcsStorage",
      () =>
        gcsStorage({
          bucket: "b",
          hmacAccessKeyId: "k",
          hmacSecret: "s",
        }),
    ],
  ] as const) {
    it(`${name} returns a Storage shape`, () => {
      const s = build();
      expect(typeof s.get).toBe("function");
      expect(typeof s.put).toBe("function");
      expect(typeof s.delete).toBe("function");
      expect(typeof s.list).toBe("function");
    });
  }
});
