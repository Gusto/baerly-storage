import { afterEach, describe, expect, test, vi } from "vitest";
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

describe("s3Storage with a credentials provider", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("refreshes the provider once after an ExpiredToken 400", async () => {
    let calls = 0;
    const fetchStub = vi.fn<typeof fetch>(async (input) => {
      const auth = (input as Request).headers.get("Authorization") ?? "";
      return auth.includes("ASIA1/")
        ? new Response("<Error><Code>ExpiredToken</Code></Error>", { status: 400 })
        : new Response("v", { status: 200, headers: { ETag: '"e"' } });
    });
    vi.stubGlobal("fetch", fetchStub);
    const storage = s3Storage({
      region: "us-east-1",
      bucket: "b",
      credentials: async () => ({ accessKeyId: `ASIA${++calls}`, secretAccessKey: "s" }),
    });
    const got = await storage.get("k");
    expect(got?.etag).toBe('"e"');
    expect(calls).toBe(2);
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });
});
