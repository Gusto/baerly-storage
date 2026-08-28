/**
 * Byte-axis sweep provisioning for the deployed workload-ceiling study
 * (lane B ticket 2).
 *
 * Provisions all four byte-axis cells in one run, calibrating each row count
 * to hit its ENCODED snapshot-byte target and recording the achieved size.
 * Writes a single sweep report the ticket-4 capture runner consumes directly.
 *
 * Resumable: re-running with the same `sweep_id` skips cells whose report
 * entries already exist, so a mid-sweep failure (credential expiry, network
 * blip, etc.) doesn't force a full restart.
 */
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { runAsCliEntrypoint } from "./cli-entrypoint.ts";
import { AwsClient } from "aws4fetch";
import { type Storage } from "@baerly/protocol";
import { S3HttpStorage } from "@baerly/adapter-node";
import {
  byteAxisCells,
  byteLabel,
  cellSpec,
  CELL_BYTE_TOLERANCE,
  type WorkloadCeilingCell,
} from "./workload-ceiling-cells.ts";
import {
  decodeWorkloadCeilingSweepReport,
  encodeWorkloadCeilingSweepReport,
  type WorkloadCeilingSweepReport,
  WORKLOAD_CEILING_CONTRACT_ID,
} from "./workload-ceiling-harness.ts";
import {
  cloudflareR2CredsFilename,
  type CloudflareTier,
  loadCloudflareR2CredsForTier,
} from "../../tests/fixtures/endpoint-creds.ts";
import { resolveWorkloadCeilingTier } from "./workload-ceiling-tier.ts";
import {
  assertStudyBucket,
  calibrateRowCount,
  provisionWorkloadCeilingFixture,
  randomIncarnation,
} from "./workload-ceiling-provision.ts";

/**
 * The sweep report if one exists, `null` on absence — and a hard failure on a
 * report that exists but does not decode.
 *
 * The distinction is load-bearing. Callers treat `null` as "first run" and
 * write a fresh empty report over the path, so swallowing a decode failure
 * would discard the `cleanup` entries recorded for fixtures ALREADY written to
 * real R2. Those entries are the only record of which keys to delete, so the
 * silent path orphans provisioned storage with no way to find it again. A
 * partially written file from an interrupted run is exactly the case that
 * produces it.
 */
export const loadFullReport = async (
  reportPath: string,
): Promise<WorkloadCeilingSweepReport | null> => {
  let raw: string;
  try {
    raw = await readFile(reportPath, { encoding: "utf-8" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw new Error(`workload-ceiling-provision-sweep: cannot read ${reportPath}`, {
      cause: error,
    });
  }
  try {
    return decodeWorkloadCeilingSweepReport(raw);
  } catch (error) {
    throw new Error(
      `workload-ceiling-provision-sweep: ${reportPath} exists but does not decode. ` +
        "Refusing to overwrite it — its cleanup entries are the only record of the " +
        "fixture keys already written to the bucket. Repair or move the file by hand.",
      { cause: error },
    );
  }
};

const COLLECTION = "items";

/** Provision a single cell, appending to the report after it succeeds. */
const provisionCell = async (input: {
  readonly cell: WorkloadCeilingCell;
  readonly storage: Storage;
  readonly sweepId: string;
  readonly reportPath: string;
  readonly existingReport: WorkloadCeilingSweepReport | null;
}): Promise<void> => {
  const { cell, storage, sweepId, reportPath, existingReport } = input;

  // Skip if the cell already exists in the report (resumability).
  const exists = existingReport?.cells.some((c) => c.scenario_id === cell.scenario_id) ?? false;
  if (exists) {
    console.log(`skipping ${cell.scenario_id} (already provisioned)`);
    return;
  }

  console.log(`calibrating ${cell.scenario_id} to ${byteLabel(cell.target)}...`);
  const calibration = calibrateRowCount({
    targetBytes: cell.target,
    documentBytes: cell.document_bytes,
    collection: COLLECTION,
    tolerance: CELL_BYTE_TOLERANCE,
  });
  console.log(
    `  calibrated: ${calibration.row_count} rows, ${calibration.achieved_bytes} bytes (${(calibration.relative_error * 100).toFixed(3)}% error)`,
  );

  const fixturePrefix = `tenants/workload-ceiling-study/collections/${sweepId}/${byteLabel(cell.target)}`;
  const incarnation = randomIncarnation();

  console.log(`  provisioning ${fixturePrefix} (incarnation ${incarnation})...`);
  const result = await provisionWorkloadCeilingFixture({
    storage,
    spec: cellSpec(cell, calibration.row_count, COLLECTION),
    fixturePrefix,
    incarnation,
  });

  // Load the latest report state, append the new cell, and rewrite.
  // This is a simple append-only file; concurrent runs are gated by the
  // same sweep_id, which is an operator's choice to set explicitly.
  const latest = (await loadFullReport(reportPath)) ?? {
    contract_id: WORKLOAD_CEILING_CONTRACT_ID,
    sweep_id: sweepId,
    collection: COLLECTION,
    cells: [],
    cleanup: [],
  };

  const newCell = {
    scenario_id: cell.scenario_id,
    axis: cell.axis,
    target_bytes: calibration.target_bytes,
    achieved_bytes: calibration.achieved_bytes,
    row_count: calibration.row_count,
    document_bytes: cell.document_bytes,
    manifest_descriptors: cell.manifest_descriptors,
    fixture_prefix: fixturePrefix,
    incarnation,
    monolithic_key: result.fixture.monolithic_key,
    manifest_key: result.fixture.manifest_key,
    descriptor_canonical_hash: result.fixture.descriptor_canonical_hash,
  };

  const newCleanup = {
    scenario_id: cell.scenario_id,
    fixture_prefix: fixturePrefix,
    written_keys: result.fixture.writes.map((w) => w.key),
    cleanup_authority: result.cleanup.authority,
  };

  const updatedReport: WorkloadCeilingSweepReport = {
    ...latest,
    cells: [...latest.cells, newCell],
    cleanup: [...latest.cleanup, newCleanup],
  };

  const encoded = encodeWorkloadCeilingSweepReport(updatedReport);
  await writeFile(reportPath, encoded);
  console.log(`  wrote report entry`);
};

async function main(): Promise<number> {
  let tier: CloudflareTier;
  try {
    tier = resolveWorkloadCeilingTier(process.env);
  } catch (error) {
    console.error(
      `workload-ceiling-provision-sweep: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
  const creds = await loadCloudflareR2CredsForTier(tier);
  if (creds === null) {
    const credsFile = cloudflareR2CredsFilename(tier);
    console.error(
      `workload-ceiling-provision-sweep: no credentials/${credsFile} found ` +
        "(tests/fixtures/endpoint-creds.ts). This script provisions fixtures " +
        "against a real R2 bucket for the deployed workload-ceiling study; " +
        "there is nothing to do without credentials.\n" +
        `Set WORKLOAD_CEILING_TIER=free to use credentials/cloudflare-free.json ` +
        `instead of credentials/cloudflare.json.`,
    );
    return 1;
  }
  console.log(
    `workload-ceiling-provision-sweep: using ${tier} tier (credentials/${cloudflareR2CredsFilename(tier)})`,
  );

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

  const sweepId = process.env["WORKLOAD_CEILING_SWEEP_ID"] ?? randomUUID();
  const outDir = "bench/results/workload-ceiling";
  const reportPath = `${outDir}/sweep-${sweepId}.json`;

  console.log(`provisioning byte-axis sweep ${sweepId}`);
  console.log(`report: ${reportPath}`);

  const existingReport = await loadFullReport(reportPath);
  if (existingReport !== null) {
    console.log(`resuming from existing report (${existingReport.cells.length} cells done)`);
  }

  const cells = byteAxisCells();
  for (const cell of cells) {
    await provisionCell({ cell, storage, sweepId, reportPath, existingReport });
  }

  const final = await loadFullReport(reportPath);
  if (final === null) {
    throw new Error("report disappeared after provisioning");
  }

  console.log();
  console.log("sweep complete:");
  console.log(`  sweep_id: ${sweepId}`);
  console.log(`  report: ${reportPath}`);
  console.log();
  console.log("cells:");
  for (const cell of final.cells) {
    console.log(
      `  ${cell.scenario_id}: row_count=${cell.row_count}, ` +
        `target_bytes=${cell.target_bytes}, achieved_bytes=${cell.achieved_bytes}, ` +
        `error=${(((cell.achieved_bytes - cell.target_bytes) / cell.target_bytes) * 100).toFixed(3)}%`,
    );
  }

  return 0;
}

await runAsCliEntrypoint(import.meta.url, main);
