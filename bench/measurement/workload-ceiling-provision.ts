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
 *  - a monolithic `SnapshotBody` at its hash-verified `snapshotKey`, the shape
 *    of today's shipped single-snapshot format — read back through
 *    `loadSnapshotAsMap`, so the control arm pays the digest check the
 *    shipped path pays;
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
import { runAsCliEntrypoint } from "./cli-entrypoint.ts";
import { AwsClient } from "aws4fetch";
import {
  encodeJsonBytes,
  snapshotHash,
  SNAPSHOT_SCHEMA_VERSION,
  type DocumentData,
  type Storage,
} from "@baerly/protocol";
import { S3HttpStorage } from "@baerly/adapter-node";
import { encodeSnapshotBody, snapshotKey, type SnapshotBody } from "@baerly/server";
import {
  encodeSnapshotChunk,
  snapshotChunkKey,
  type SnapshotChunk,
  type SnapshotChunkDescriptor,
  encodeSnapshotManifest,
  snapshotManifestKey,
  type SnapshotManifest,
} from "@baerly/server/_internal/testing";
import { hashCanonicalJson, type CanonicalJsonValue } from "./canonical-json.ts";
import { createExactKeyCleanup, type ExactKeyCleanup } from "./storage-factory.ts";
import {
  encodeWorkloadCeilingFixtureDescriptor,
  WORKLOAD_CEILING_BUCKET_NAME,
  WORKLOAD_CEILING_CONTRACT_ID,
  workloadCeilingFixtureDescriptorKey,
  type WorkloadCeilingFixtureDescriptor,
} from "./workload-ceiling-harness.ts";
import { WORKLOAD_CEILING_STUDY } from "./workload-ceiling-contract.ts";
import {
  cloudflareR2CredsFilename,
  type CloudflareTier,
  loadCloudflareR2CredsForTier,
} from "../../tests/fixtures/endpoint-creds.ts";
import { resolveWorkloadCeilingTier } from "./workload-ceiling-tier.ts";

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
  // Every id is padded to the same width, so the empty-payload envelope encodes
  // to one length for the whole fixture. Computing it per row would put a JSON
  // encode inside the loop, and `calibrateRowCount` calls this once per
  // binary-search probe.
  const bare = encodeJsonBytes({ _id: "row-".padEnd(4 + width, "0"), payload: "" }).byteLength;
  const padLength = Math.max(0, spec.document_bytes - bare);
  const payload = "x".repeat(padLength);
  const rows: FixtureRow[] = [];
  for (let index = 0; index < spec.row_count; index++) {
    const id = `row-${String(index).padStart(width, "0")}`;
    rows.push({ _id: id, body: { _id: id, payload } });
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

  // The monolithic representation is a REAL snapshot: the exact SnapshotBody
  // the shipped compactor emits, encoded by the shipped encoder, at the key
  // grammar the shipped reader parses a digest out of. The control arm then
  // measures `loadSnapshotAsMap` — hash verification included — rather than a
  // bare JSON.parse that understates the format it stands in for.
  const monolithicBody: SnapshotBody = {
    schema_version: SNAPSHOT_SCHEMA_VERSION,
    min_seq: 0,
    max_seq: 0,
    collection: spec.collection,
    // Already ascending by construction: `buildRows` pads every id to one
    // constant width, so `row-000 < row-001 < …` lexicographically.
    docs: rows.map((row) => ({ _id: row._id, body: row.body })),
  };
  const monolithicBytes = encodeSnapshotBody(monolithicBody);
  const monolithicKey = snapshotKey(fixturePrefix, 0, 0, await snapshotHash(monolithicBytes));
  writes.push({ key: monolithicKey, body: monolithicBytes });

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

  // One codec, shared with the deployed Worker that reads these bytes back
  // (`workload-ceiling-harness.ts`) — the field set has a single source of
  // truth, so a rename here fails this build rather than the Worker's runtime.
  const descriptorValue: WorkloadCeilingFixtureDescriptor = {
    contract_id: WORKLOAD_CEILING_CONTRACT_ID,
    collection: spec.collection,
    monolithic_key: monolithicKey,
    manifest_key: manifestKey,
    log_seq_start: 0,
  };
  const descriptorCanonical = encodeWorkloadCeilingFixtureDescriptor(descriptorValue);
  const descriptorKey = workloadCeilingFixtureDescriptorKey(fixturePrefix);
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

/** Preflight that credentials target the correct bucket. Exported so the sweep CLI reuses it verbatim. */
export const assertStudyBucket = (creds: { readonly bucket: string }): void => {
  if (creds.bucket !== WORKLOAD_CEILING_BUCKET_NAME) {
    throw new WorkloadCeilingProvisionError(
      "bucket",
      `credentials name bucket "${creds.bucket}", but the study Worker's wrangler.jsonc binds env.BUCKET to "${WORKLOAD_CEILING_BUCKET_NAME}". Point the credentials file at "${WORKLOAD_CEILING_BUCKET_NAME}", or change both together.`,
    );
  }
};

/**
 * Encoded byte length of the monolithic representation for a given row count.
 * The single source of "how big is this cell really", used by both the
 * calibrator and the sweep report — so the number the report publishes is the
 * number the calibrator optimized, not a re-derivation that could disagree.
 */
export const monolithicEncodedBytes = (
  rowCount: number,
  documentBytes: number,
  collection: string,
): number => {
  const spec: WorkloadCeilingFixtureSpec = {
    scenario_id: "calibration",
    collection,
    row_count: rowCount,
    document_bytes: documentBytes,
    manifest_descriptors: 1,
  };
  const rows = buildRows(spec);
  return encodeJsonBytes({
    schema_version: SNAPSHOT_SCHEMA_VERSION,
    min_seq: 0,
    max_seq: 0,
    collection,
    docs: rows.map((row) => ({ _id: row._id, body: row.body })),
  }).byteLength;
};

export interface CalibrationResult {
  readonly row_count: number;
  readonly achieved_bytes: number;
  readonly target_bytes: number;
  /** `(achieved - target) / target`. Signed, so an undershoot is visible as such. */
  readonly relative_error: number;
}

/**
 * Pure. Solves for the row count whose ENCODED monolithic snapshot is closest to
 * `targetBytes`.
 *
 * Binary search, not a division: `document_bytes` is the size of one encoded
 * document, while a row inside a `SnapshotBody` additionally carries
 * `{"_id":…,"body":…}` envelope, and the whole body carries a fixed header. The
 * naive `round(target / document_bytes)` the single-fixture CLI used
 * (`workload-ceiling-provision.ts:350`) therefore overshoots by a few percent,
 * which makes the axis label nominal rather than measured — and
 * `WORKLOAD_CEILING_STUDY.axis_sweeps.byte_axis.collection_bytes_measure` says
 * "encoded-snapshot-bytes".
 *
 * Encoded length is monotone non-decreasing in `rowCount`, so the search
 * converges. It is not strictly monotone in a useful sense across a power-of-ten
 * boundary — the id pad width widens there and every id grows a byte at once —
 * which is why the result carries its achieved size and relative error rather
 * than promising an exact hit.
 *
 * @throws WorkloadCeilingProvisionError when no row count lands within
 *   `tolerance`; a silent miss would publish a mislabeled axis point.
 */
export const calibrateRowCount = (input: {
  readonly targetBytes: number;
  readonly documentBytes: number;
  readonly collection: string;
  readonly tolerance: number;
}): CalibrationResult => {
  // Upper bound: every row's encoded contribution is at least
  // `document_bytes` — padding only ever brings the bare row UP to that size,
  // and the snapshot envelope only adds — so `ceil(target / document_bytes)`
  // rows already exceed the target. Bounding on the floor of 32 that
  // `assertSpec` enforces would also be correct but is 64x looser at the
  // study's 2048-byte documents, and each extra probe builds and JSON-encodes
  // every row just to read the result's byteLength.
  let hi = Math.max(1, Math.ceil(input.targetBytes / input.documentBytes));
  let lo = 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const encoded = monolithicEncodedBytes(mid, input.documentBytes, input.collection);
    if (encoded < input.targetBytes) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }

  // The search finds the first row count at or above target. Evaluate both
  // lo and lo - 1 (if lo > 1) and keep whichever has smaller absolute error.
  const loBytes = monolithicEncodedBytes(lo, input.documentBytes, input.collection);
  const loError = Math.abs((loBytes - input.targetBytes) / input.targetBytes);
  let bestRow = lo;
  let bestBytes = loBytes;
  let bestError = loError;

  if (lo > 1) {
    const prevRow = lo - 1;
    const prevBytes = monolithicEncodedBytes(prevRow, input.documentBytes, input.collection);
    const prevError = Math.abs((prevBytes - input.targetBytes) / input.targetBytes);
    if (prevError < bestError || (prevError === bestError && prevRow < bestRow)) {
      bestRow = prevRow;
      bestBytes = prevBytes;
      bestError = prevError;
    }
  }

  if (bestError > input.tolerance) {
    throw new WorkloadCeilingProvisionError(
      "tolerance",
      `no row count within ${input.tolerance * 100}% of ${input.targetBytes} bytes (best: ${bestRow} rows, ${bestBytes} bytes, ${(bestError * 100).toFixed(3)}% error)`,
    );
  }

  return {
    row_count: bestRow,
    achieved_bytes: bestBytes,
    target_bytes: input.targetBytes,
    relative_error: (bestBytes - input.targetBytes) / input.targetBytes,
  };
};

/**
 * CLI entrypoint (`pnpm bench:workload-ceiling:provision`). Real R2
 * provisioning, so it requires `credentials/cloudflare.json` (or
 * `credentials/cloudflare-free.json` when `WORKLOAD_CEILING_TIER=free`) —
 * the same file shape and skip-honestly posture the credential-gated test
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
  let tier: CloudflareTier;
  try {
    tier = resolveWorkloadCeilingTier(process.env);
  } catch (error) {
    console.error(
      `workload-ceiling-provision: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
  const creds = await loadCloudflareR2CredsForTier(tier);
  if (creds === null) {
    const credsFile = cloudflareR2CredsFilename(tier);
    console.error(
      `workload-ceiling-provision: no credentials/${credsFile} found ` +
        `(tests/fixtures/endpoint-creds.ts). This script provisions fixtures ` +
        "against a real R2 bucket for the deployed workload-ceiling study; " +
        "there is nothing to do without credentials.\n" +
        `Set WORKLOAD_CEILING_TIER=free to use credentials/cloudflare-free.json ` +
        `instead of credentials/cloudflare.json.`,
    );
    return 1;
  }
  console.log(
    `workload-ceiling-provision: using ${tier} tier (credentials/${cloudflareR2CredsFilename(tier)})`,
  );

  // Preflight the one coupling nothing else enforces: the deployed Worker's
  // `env.BUCKET` binding is a literal in wrangler.jsonc, so fixtures written
  // to any other bucket are invisible to it. Refuse before writing anything.
  assertStudyBucket(creds);

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
await runAsCliEntrypoint(import.meta.url, main);
