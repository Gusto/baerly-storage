import { describe, expect, test } from "vitest";
import { snapshotHash } from "@baerly/protocol";
import { decodeSnapshotChunk, decodeSnapshotManifest } from "@baerly/server/_internal/testing";
import {
  buildWorkloadCeilingFixture,
  WorkloadCeilingProvisionError,
  type WorkloadCeilingFixtureSpec,
} from "./workload-ceiling-provision.ts";

const incarnation = "ab".repeat(16);
const spec: WorkloadCeilingFixtureSpec = {
  scenario_id: "scen-1",
  collection: "coll-1",
  row_count: 7,
  document_bytes: 64,
  manifest_descriptors: 3,
};

describe("buildWorkloadCeilingFixture", () => {
  test("groups rows into contiguous near-even chunks (7 rows / 3 groups → 3/2/2)", async () => {
    const fixture = await buildWorkloadCeilingFixture(spec, "fixtures/x", incarnation);
    const manifestBytes = fixture.writes.find((w) => w.key === fixture.manifest_key)!.body;
    const manifest = await decodeSnapshotManifest(manifestBytes, fixture.manifest_key, "coll-1", 0);
    expect(manifest.chunks.map((c) => c.row_count)).toEqual([3, 2, 2]);
    // Pad width is derived from the max index — one digit for a 7-row set.
    expect(manifest.chunks[0]!.first_id).toBe("row-0");
    expect(manifest.chunks.at(-1)!.last_id).toBe("row-6");
  });

  test("every chunk round-trips through the strict decoder", async () => {
    const fixture = await buildWorkloadCeilingFixture(spec, "fixtures/x", incarnation);
    const manifestBytes = fixture.writes.find((w) => w.key === fixture.manifest_key)!.body;
    const manifest = await decodeSnapshotManifest(manifestBytes, fixture.manifest_key, "coll-1", 0);
    for (const descriptor of manifest.chunks) {
      const chunkBytes = fixture.writes.find((w) => w.key === descriptor.key)!.body;
      const chunk = await decodeSnapshotChunk(chunkBytes, descriptor.key, "coll-1", descriptor);
      expect(descriptor.byte_length).toBe(chunkBytes.byteLength);
      expect(chunk.docs).toHaveLength(descriptor.row_count);
    }
  });

  test("is deterministic for the same incarnation, and keys carry its digest", async () => {
    const a = await buildWorkloadCeilingFixture(spec, "fixtures/x", incarnation);
    const b = await buildWorkloadCeilingFixture(spec, "fixtures/x", incarnation);
    expect(a.writes).toEqual(b.writes);
    const manifestBytes = a.writes.find((w) => w.key === a.manifest_key)!.body;
    const manifestDigest = await snapshotHash(manifestBytes);
    expect(a.manifest_key).toContain(manifestDigest.slice(0, 16));
  });

  test("pads every row to the declared document size and numbers ids stably", async () => {
    const fixture = await buildWorkloadCeilingFixture(spec, "fixtures/x", incarnation);
    const monolithic = fixture.writes.find((w) => w.key === fixture.monolithic_key)!.body;
    const parsed = JSON.parse(new TextDecoder().decode(monolithic)) as {
      rows: { _id: string; body: { payload: string } }[];
    };
    expect(parsed.rows.map((r) => r._id)).toEqual([
      "row-0",
      "row-1",
      "row-2",
      "row-3",
      "row-4",
      "row-5",
      "row-6",
    ]);
    for (const row of parsed.rows) {
      expect(row.body.payload.length).toBeGreaterThan(0);
    }
  });

  test("writes monolithic + one chunk per group + manifest + descriptor", async () => {
    const fixture = await buildWorkloadCeilingFixture(spec, "fixtures/x", incarnation);
    expect(fixture.writes).toHaveLength(1 + 3 + 1 + 1);
    expect(fixture.writes.map((w) => w.key)).toContain(fixture.descriptor_key);
  });
});

describe("spec and argument validation", () => {
  const cases = [
    [{ ...spec, scenario_id: "  " }, "scenario_id"],
    [{ ...spec, collection: "" }, "collection"],
    [{ ...spec, row_count: 0 }, "row_count"],
    [{ ...spec, document_bytes: 31 }, "document_bytes"],
    [{ ...spec, manifest_descriptors: 0 }, "manifest_descriptors"],
    [{ ...spec, manifest_descriptors: 8 }, "manifest_descriptors"], // exceeds row_count
  ] as const;

  test.each(cases)("rejects %j on %s", async (bad, field) => {
    await expect(
      buildWorkloadCeilingFixture(bad as WorkloadCeilingFixtureSpec, "fixtures/x", incarnation),
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof WorkloadCeilingProvisionError && error.field === field,
    );
  });

  test("rejects an unclean fixture prefix and a non-hex incarnation", async () => {
    await expect(buildWorkloadCeilingFixture(spec, "/abs", incarnation)).rejects.toSatisfy(
      (e: unknown) => e instanceof WorkloadCeilingProvisionError && e.field === "fixturePrefix",
    );
    await expect(
      buildWorkloadCeilingFixture(spec, "fixtures/x", "AB".repeat(16)),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof WorkloadCeilingProvisionError && e.field === "incarnation",
    );
  });
});
