/**
 * Default-project global setup: collects every `gate()` record of the run
 * (one JSONL file per worker process) and, at teardown, fails the run if
 * any gate this run expected skipped. See `tests/setup/gate-manifest.ts`
 * for what is expected. A teardown throw exits vitest non-zero after the
 * test summary; the violation lines name the gate, the files and the fix.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";
import { diffGates, type GateRecord } from "./gate-manifest.ts";

export default function setup(project: TestProject): () => void {
  const dir = mkdtempSync(join(tmpdir(), "baerly-gate-ledger-"));
  project.provide("baerlyGateLedger", dir);
  return () => {
    const records: GateRecord[] = [];
    for (const name of readdirSync(dir)) {
      for (const line of readFileSync(join(dir, name), "utf8").split("\n")) {
        if (line !== "") {
          records.push(JSON.parse(line) as GateRecord);
        }
      }
    }
    rmSync(dir, { recursive: true, force: true });
    const violations = diffGates(process.env, records);
    if (violations.length > 0) {
      throw new Error(
        `gate manifest: ${violations.length} expected gate(s) did not run\n${violations.map((v) => `  - ${v}`).join("\n")}`,
      );
    }
  };
}
