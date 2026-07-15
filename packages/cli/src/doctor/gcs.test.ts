import { describe, expect, test } from "vitest";
import { doctorGcsConfig } from "./gcs.ts";

const DUMMY_CREDENTIALS = { accessKeyId: "GOOG1EDUMMY", secretAccessKey: "dummysecret" };

describe("doctorGcsConfig", () => {
  test("versioning enabled → warning finding naming the bucket, fix mentions --no-versioning", async () => {
    const report = await doctorGcsConfig({
      endpoint: "https://storage.googleapis.com",
      bucket: "my-bucket",
      credentials: DUMMY_CREDENTIALS,
      fetchImpl: async () =>
        new Response(
          "<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>",
          {
            status: 200,
          },
        ),
    });
    expect(report.status).toBe("warning");
    const versioning = report.findings.find((f) => f.check === "gcs-object-versioning");
    expect(versioning?.severity).toBe("warning");
    expect(versioning?.message).toContain("my-bucket");
    expect(versioning?.fix).toContain("--no-versioning");
  });

  test("versioning disabled → ok finding; soft-delete info finding present; overall status ok", async () => {
    const report = await doctorGcsConfig({
      endpoint: "https://storage.googleapis.com",
      bucket: "my-bucket",
      credentials: DUMMY_CREDENTIALS,
      fetchImpl: async () => new Response("<VersioningConfiguration/>", { status: 200 }),
    });
    expect(report.status).toBe("ok");
    const versioning = report.findings.find((f) => f.check === "gcs-object-versioning");
    expect(versioning?.severity).toBe("ok");
    const softDelete = report.findings.find((f) => f.check === "gcs-soft-delete");
    expect(softDelete?.severity).toBe("info");
  });

  test("versioning probe non-200 → info finding mentioning the status; never throws", async () => {
    const report = await doctorGcsConfig({
      endpoint: "https://storage.googleapis.com",
      bucket: "my-bucket",
      credentials: DUMMY_CREDENTIALS,
      fetchImpl: async () => new Response("forbidden", { status: 403 }),
    });
    const versioning = report.findings.find((f) => f.check === "gcs-object-versioning");
    expect(versioning?.severity).toBe("info");
    expect(versioning?.message).toContain("403");
  });

  test("versioning fetch throws → info finding; never throws", async () => {
    const report = await doctorGcsConfig({
      endpoint: "https://storage.googleapis.com",
      bucket: "my-bucket",
      credentials: DUMMY_CREDENTIALS,
      fetchImpl: async () => {
        throw new Error("ECONNRESET");
      },
    });
    const versioning = report.findings.find((f) => f.check === "gcs-object-versioning");
    expect(versioning?.severity).toBe("info");
    expect(versioning?.message).toContain("ECONNRESET");
  });

  test("soft-delete info finding is always present, mentions soft-delete, fix has --clear-soft-delete", async () => {
    const report = await doctorGcsConfig({
      endpoint: "https://storage.googleapis.com",
      bucket: "my-bucket",
      credentials: DUMMY_CREDENTIALS,
      fetchImpl: async () => new Response("<VersioningConfiguration/>", { status: 200 }),
    });
    const softDelete = report.findings.find((f) => f.check === "gcs-soft-delete");
    expect(softDelete).toBeDefined();
    expect(softDelete?.message.toLowerCase()).toContain("soft-delete");
    expect(softDelete?.fix).toContain("--clear-soft-delete");
  });
});
