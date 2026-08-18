/**
 * Exact fixture provisioning for the deployed workload-ceiling study (parent
 * plan Task 8 Step 4).
 *
 * Builds fixtures out of band from `WORKLOAD_CEILING_STUDY`
 * (`workload-ceiling-contract.ts`) — the Worker never provisions anything
 * itself (`bench/workload-ceiling-worker/src/index.ts`). One
 * `WorkloadCeilingFixtureSpec` produces ONE logical row set, materialized
 * into BOTH storage shapes the study compares side by side under a single
 * `fixture_prefix`:
 *
 *  - a monolithic JSON blob (`monolithic.json`), the shape of today's
 *    shipped single-snapshot format;
 *  - the proposed manifest + chunk layout (`snapshot-manifest.ts` /
 *    `snapshot-chunk.ts`), so `monolithic-control` and `chunked-candidate`
 *    runs measure the identical data through two different storage shapes.
 *
 * `buildWorkloadCeilingFixture` is pure — no I/O, easy to unit-test and to
 * hash independently of any backend. `provisionWorkloadCeilingFixture` is
 * the one function that touches `Storage`, and it returns an
 * `ExactKeyCleanup` (`storage-factory.ts`) over precisely the keys it wrote —
 * never a bucket, never an unresolved prefix.
 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AwsClient } from "aws4fetch";
import { encodeJsonBytes, snapshotHash, type DocumentData, type Storage } from "@baerly/protocol";
import { S3HttpStorage } from "@baerly/adapter-node";
import {
  encodeSnapshotChunk,
  snapshotChunkKey,
  type SnapshotChunk,
  type SnapshotChunkDescriptor,
  encodeSnapshotManifest,
  snapshotManifestKey,
  type SnapshotManifest,
} from "@baerly/server/_internal/testing";
import { canonicalJson, hashCanonicalJson, type CanonicalJsonValue } from "./canonical-json.ts";
import { createExactKeyCleanup, type ExactKeyCleanup } from "./storage-factory.ts";
import { loadEndpointCreds } from "../../tests/fixtures/endpoint-creds.ts";
import { WORKLOAD_CEILING_CONTRACT_ID } from "./workload-ceiling-harness.ts";
import { WORKLOAD_CEILING_STUDY } from "./workload-ceiling-contract.ts";

const INCARNATION_PATTERN = /^[0-9a-f]{32}$/;

export interface WorkloadCeilingFixtureSpec {
  readonly scenario_id: string;
  readonly collection: string;
  readonly row_count: number;
  readonly document_bytes: number;
  readonly manifest_descriptors: number;
}

export class WorkloadCeilingProvisionError extends Error {
  readonly code = "WorkloadCeilingProvisionInvalid" as const;
  readonly field: string;
  constructor(field: string, detail: string) {
    super(`bench/measurement/workload-ceiling-provision: invalid ${field} — ${detail}`);
    this.name = "WorkloadCeilingProvisionError";
    this.field = field;
  }
}

function assertSpec(spec: WorkloadCeilingFixtureSpec): void {
  if (spec.scenario_id.trim() === "") {
    throw new WorkloadCeilingProvisionError("scenario_id", "must be a nonempty string");
  }
  if (spec.collection.trim() === "") {
    throw new WorkloadCeilingProvisionError("collection", "must be a nonempty string");
  }
  if (!Number.isInteger(spec.row_count) || spec.row_count < 1) {
    throw new WorkloadCeilingProvisionError("row_count", "must be a positive integer");
  }
  if (!Number.isInteger(spec.document_bytes) || spec.document_bytes < 32) {
    throw new WorkloadCeilingProvisionError("document_bytes", "must be an integer >= 32");
  }
  if (!Number.isInteger(spec.manifest_descriptors) || spec.manifest_descriptors < 1) {
    throw new WorkloadCeilingProvisionError("manifest_descriptors", "must be a positive integer");
  }
  if (spec.manifest_descriptors > spec.row_count) {
    throw new WorkloadCeilingProvisionError(
      "manifest_descriptors",
      "must not exceed row_count (every chunk must carry at least one row)",
    );
  }
}

interface FixtureRow {
  readonly _id: string;
  readonly body: DocumentData;
}

/** Deterministic scalar-ordered rows: `row-000`, `row-001`, ... — same input, same bytes, every run. */
function buildRows(spec: WorkloadCeilingFixtureSpec): readonly FixtureRow[] {
  const width = String(spec.row_count - 1).length;
  const rows: FixtureRow[] = [];
  for (let index = 0; index < spec.row_count; index++) {
    const id = `row-${String(index).padStart(width, "0")}`;
    const bare = encodeJsonBytes({ _id: id, payload: "" }).byteLength;
    const padLength = Math.max(0, spec.document_bytes - bare);
    rows.push({ _id: id, body: { _id: id, payload: "x".repeat(padLength) } });
  }
  return rows;
}

/** Contiguous, near-even groups over the already-sorted rows — `manifest_descriptors` chunks, never zero rows each. */
function groupRows(
  rows: readonly FixtureRow[],
  groupCount: number,
): readonly (readonly FixtureRow[])[] {
  const groups: FixtureRow[][] = [];
  const base = Math.floor(rows.length / groupCount);
  const extra = rows.length % groupCount;
  let offset = 0;
  for (let g = 0; g < groupCount; g++) {
    const size = base + (g < extra ? 1 : 0);
    groups.push(rows.slice(offset, offset + size));
    offset += size;
  }
  return groups;
}

export interface WorkloadCeilingFixtureWrite {
  readonly key: string;
  readonly body: Uint8Array;
}

export interface WorkloadCeilingFixture {
  readonly spec: WorkloadCeilingFixtureSpec;
  readonly fixture_prefix: string;
  readonly incarnation: string;
  readonly descriptor_key: string;
  /** SHA-256 over the descriptor's canonical JSON bytes — persisted before the Worker is ever invoked. */
  readonly descriptor_canonical_hash: string;
  readonly manifest_key: string;
  readonly monolithic_key: string;
  readonly writes: readonly WorkloadCeilingFixtureWrite[];
}

/**
 * Pure. Builds the monolithic blob, the manifest + chunk set, and the
 * fixture descriptor the Worker reads to find both — all as an in-memory
 * write plan. No `Storage` touched here.
 */
export const buildWorkloadCeilingFixture = async (
  spec: WorkloadCeilingFixtureSpec,
  fixturePrefix: string,
  incarnation: string,
): Promise<WorkloadCeilingFixture> => {
  assertSpec(spec);
  if (fixturePrefix.length === 0 || fixturePrefix.startsWith("/") || fixturePrefix.endsWith("/")) {
    throw new WorkloadCeilingProvisionError(
      "fixturePrefix",
      "must be a nonempty clean relative prefix",
    );
  }
  if (!INCARNATION_PATTERN.test(incarnation)) {
    throw new WorkloadCeilingProvisionError("incarnation", "must be 32 lowercase hex characters");
  }

  const rows = buildRows(spec);
  const writes: WorkloadCeilingFixtureWrite[] = [];

  const monolithicKey = `${fixturePrefix}/monolithic.json`;
  const monolithicValue = {
    collection: spec.collection,
    rows: rows.map((row) => ({ _id: row._id, body: row.body as CanonicalJsonValue })),
  };
  writes.push({
    key: monolithicKey,
    body: new TextEncoder().encode(canonicalJson(monolithicValue as unknown as CanonicalJsonValue)),
  });

  const groups = groupRows(rows, spec.manifest_descriptors);
  const chunkDescriptors: SnapshotChunkDescriptor[] = [];
  for (const group of groups) {
    const chunk: SnapshotChunk = {
      schema_version: 2,
      collection: spec.collection,
      incarnation,
      first_id: group[0]!._id,
      last_id: group.at(-1)!._id,
      docs: group.map((row) => row.body),
    };
    const encoded = encodeSnapshotChunk(chunk);
    const digest = await snapshotHash(encoded);
    const key = snapshotChunkKey(fixturePrefix, incarnation, digest);
    writes.push({ key, body: encoded });
    chunkDescriptors.push({
      first_id: chunk.first_id,
      last_id: chunk.last_id,
      key,
      byte_length: encoded.byteLength,
      row_count: group.length,
    });
  }

  const manifest: SnapshotManifest = {
    schema_version: 2,
    collection: spec.collection,
    log_seq_start: 0,
    incarnation,
    collation: "utf8-scalar-v1",
    chunks: chunkDescriptors,
  };
  const manifestEncoded = encodeSnapshotManifest(manifest);
  const manifestDigest = await snapshotHash(manifestEncoded);
  const manifestKey = snapshotManifestKey(fixturePrefix, incarnation, manifestDigest);
  writes.push({ key: manifestKey, body: manifestEncoded });

  const descriptorValue = {
    contract_id: WORKLOAD_CEILING_CONTRACT_ID,
    collection: spec.collection,
    monolithic_key: monolithicKey,
    manifest_key: manifestKey,
    log_seq_start: 0,
  };
  const descriptorCanonical = canonicalJson(descriptorValue as unknown as CanonicalJsonValue);
  const descriptorKey = `${fixturePrefix}/fixture.json`;
  writes.push({ key: descriptorKey, body: new TextEncoder().encode(descriptorCanonical) });

  return {
    spec,
    fixture_prefix: fixturePrefix,
    incarnation,
    descriptor_key: descriptorKey,
    descriptor_canonical_hash: await hashCanonicalJson(
      descriptorValue as unknown as CanonicalJsonValue,
    ),
    manifest_key: manifestKey,
    monolithic_key: monolithicKey,
    writes,
  };
};

export interface WorkloadCeilingProvisionResult {
  readonly fixture: WorkloadCeilingFixture;
  readonly cleanup: ExactKeyCleanup;
}

/**
 * Writes every artifact `buildWorkloadCeilingFixture` planned, then returns
 * an `ExactKeyCleanup` over exactly those keys. Persists the descriptor +
 * manifest before returning — this function's return is the earliest point
 * a caller can invoke the Worker, and by then both are already durable.
 */
export const provisionWorkloadCeilingFixture = async (input: {
  readonly storage: Storage;
  readonly spec: WorkloadCeilingFixtureSpec;
  readonly fixturePrefix: string;
  readonly incarnation: string;
}): Promise<WorkloadCeilingProvisionResult> => {
  const fixture = await buildWorkloadCeilingFixture(
    input.spec,
    input.fixturePrefix,
    input.incarnation,
  );
  for (const write of fixture.writes) {
    await input.storage.put(write.key, write.body);
  }
  return {
    fixture,
    cleanup: createExactKeyCleanup({
      storage: input.storage,
      keys: fixture.writes.map((write) => write.key),
    }),
  };
};

/** A fresh 32-lowercase-hex incarnation, matching `packages/server/src/snapshot-manifest.ts`'s grammar. */
export const randomIncarnation = (): string => randomUUID().replaceAll("-", "");

/**
 * CLI entrypoint (`pnpm bench:workload-ceiling:provision`). Real R2
 * provisioning, so it requires `credentials/cloudflare.json` (the
 * `loadEndpointCreds` convention, `tests/fixtures/endpoint-creds.ts`) — the
 * same file shape and skip-honestly posture the credential-gated test
 * suites use, except here absence is a script failure rather than a skip:
 * there is nothing useful this script can do without a real bucket.
 *
 * Deliberately does NOT invoke the Worker or clean up after itself — a
 * provisioned fixture must outlive this process so
 * `workload-ceiling-collect.ts` and a manual Worker invocation can use it.
 * The returned `ExactKeyCleanup`'s authority is written into the report file
 * so a later cleanup step can reconstruct exactly which keys to remove.
 */
async function main(): Promise<number> {
  const creds = await loadEndpointCreds("cloudflare.json");
  if (creds === null) {
    console.error(
      "workload-ceiling-provision: no credentials/cloudflare.json found " +
        "(tests/fixtures/endpoint-creds.ts). This script provisions fixtures " +
        "against a real R2 bucket for the deployed workload-ceiling study; " +
        "there is nothing to do without credentials.",
    );
    return 1;
  }

  const signer = new AwsClient({
    accessKeyId: creds.credentials.accessKeyId,
    secretAccessKey: creds.credentials.secretAccessKey,
    region: creds.region,
    service: "s3",
  });
  const storage = new S3HttpStorage({
    endpoint: creds.endpoint,
    bucket: creds.bucket,
    sign: (req) => signer.sign(req),
  });

  const runId = process.env["WORKLOAD_CEILING_RUN_ID"] ?? randomUUID();
  const scenarioId = process.env["WORKLOAD_CEILING_SCENARIO_ID"] ?? "byte-axis/default/hot-key";
  const documentBytes = Number(
    process.env["WORKLOAD_CEILING_DOCUMENT_BYTES"] ??
      WORKLOAD_CEILING_STUDY.axis_sweeps.byte_axis.document_bytes,
  );
  const collectionBytesTarget = Number(
    process.env["WORKLOAD_CEILING_COLLECTION_BYTES"] ??
      WORKLOAD_CEILING_STUDY.minimum_useful_targets.byte_axis.collection_bytes,
  );
  const manifestDescriptors = Number(process.env["WORKLOAD_CEILING_MANIFEST_DESCRIPTORS"] ?? 8);
  const spec: WorkloadCeilingFixtureSpec = {
    scenario_id: scenarioId,
    collection: "items",
    row_count: Math.max(1, Math.round(collectionBytesTarget / documentBytes)),
    document_bytes: documentBytes,
    manifest_descriptors: manifestDescriptors,
  };
  const fixturePrefix = `tenants/workload-ceiling-study/collections/${runId}`;
  const incarnation = randomIncarnation();

  const result = await provisionWorkloadCeilingFixture({
    storage,
    spec,
    fixturePrefix,
    incarnation,
  });

  const report = {
    run_id: runId,
    spec,
    fixture_prefix: fixturePrefix,
    incarnation,
    descriptor_key: result.fixture.descriptor_key,
    descriptor_canonical_hash: result.fixture.descriptor_canonical_hash,
    manifest_key: result.fixture.manifest_key,
    monolithic_key: result.fixture.monolithic_key,
    written_keys: result.fixture.writes.map((write) => write.key),
    cleanup_authority: result.cleanup.authority,
  };
  const outDir = "bench/results/workload-ceiling";
  await mkdir(outDir, { recursive: true });
  const outPath = `${outDir}/fixture-${runId}.json`;
  await writeFile(outPath, JSON.stringify(report, null, 2));
  console.log(`provisioned fixture ${fixturePrefix} (incarnation ${incarnation})`);
  console.log(`descriptor canonical hash: ${result.fixture.descriptor_canonical_hash}`);
  console.log(`wrote ${outPath}`);
  return 0;
}

// CLI entrypoint guard: `main()` runs only when this module is executed
// directly, never when a test imports it — with a credentials file present
// in the working tree, an import must never provision a real R2 fixture.
const isCli =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]!);
if (isCli) {
  process.exitCode = await main();
}
