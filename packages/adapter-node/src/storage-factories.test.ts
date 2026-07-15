import { describe, expect, test } from "vitest";
import { GcsHttpStorage } from "./gcs-http.ts";
import { gcsStorage, minioStorage, r2Storage, s3Storage } from "./storage-factories.ts";

describe("storage factories", () => {
  // Each factory returns a `Storage` shape — the four kernel
  // methods are present as functions. We don't dispatch any HTTP
  // here; the conformance test exercises the wire.
  const sample = {
    credentials: { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret" },
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
          credentials: { accessKeyId: "k", secretAccessKey: "s" },
        }),
    ],
  ] as const) {
    test(`${name} returns a Storage shape`, () => {
      const s = build();
      expect(typeof s.get).toBe("function");
      expect(typeof s.put).toBe("function");
      expect(typeof s.delete).toBe("function");
      expect(typeof s.list).toBe("function");
    });
  }

  test("gcsStorage returns a native GcsHttpStorage over storage.googleapis.com", () => {
    const s = gcsStorage({
      bucket: "b",
      credentials: { accessKeyId: "id", secretAccessKey: "secret" },
    });
    expect(s).toBeInstanceOf(GcsHttpStorage);
  });
});
