import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  encodeWorkloadCeilingSweepReport,
  WORKLOAD_CEILING_CONTRACT_ID,
  type WorkloadCeilingSweepReport,
} from "./workload-ceiling-harness.ts";
import { loadFullReport } from "./workload-ceiling-provision-sweep.ts";

const REPORT: WorkloadCeilingSweepReport = {
  contract_id: WORKLOAD_CEILING_CONTRACT_ID,
  sweep_id: "sweep-001",
  collection: "items",
  cells: [],
  cleanup: [
    {
      scenario_id: "byte-axis/512KiB",
      fixture_prefix: "tenants/study/collections/sweep-001/512KiB",
      written_keys: ["tenants/study/collections/sweep-001/512KiB/monolithic.json"],
      cleanup_authority: { type: "exact-key", keys: [] },
    },
  ],
};

const inTempDir = async (name: string): Promise<string> =>
  join(await mkdtemp(join(tmpdir(), "workload-ceiling-sweep-")), name);

describe("loadFullReport", () => {
  test("absence is null, so the first run starts from an empty report", async () => {
    await expect(loadFullReport(await inTempDir("report.json"))).resolves.toBeNull();
  });

  test("round-trips an existing report", async () => {
    const path = await inTempDir("report.json");
    await writeFile(path, encodeWorkloadCeilingSweepReport(REPORT));
    await expect(loadFullReport(path)).resolves.toEqual(REPORT);
  });

  test("a report that does not decode refuses instead of reading as absent", async () => {
    // The orphaned-storage guard. A caller reads null as "first run" and
    // overwrites the path with a fresh empty report, which would discard the
    // `cleanup` entries — the only record of the keys already written to the
    // bucket. A partially written file from an interrupted run is exactly the
    // case that produces it.
    const path = await inTempDir("report.json");
    await writeFile(path, encodeWorkloadCeilingSweepReport(REPORT).slice(0, 40));
    await expect(loadFullReport(path)).rejects.toThrow(/exists but does not decode/);
  });

  test("a report that parses but is not canonical also refuses", async () => {
    const path = await inTempDir("report.json");
    await writeFile(path, `${encodeWorkloadCeilingSweepReport(REPORT)} `);
    await expect(loadFullReport(path)).rejects.toThrow(/exists but does not decode/);
  });

  test("a read failure that is not absence refuses", async () => {
    // A directory where a file is expected: EISDIR, not ENOENT. Absence has to
    // be ENOENT alone or an unreadable report reads as a first run.
    await expect(loadFullReport(tmpdir())).rejects.toThrow(/cannot read/);
  });
});
