/**
 * `gate()`: how a gated suite reports whether it runs. Call it at module
 * scope (collection time) and feed the result to `describe.runIf(...)` or a
 * variant filter:
 *
 * ```ts
 * const minioEnabled = gate("minio");
 * describe.runIf(gate("conformance-aws", creds !== null))("aws", ...);
 * ```
 *
 * The one-argument form uses the gate's opt-in env as its readiness. Pass
 * `ready` when the suite needs more than the env (a credentials file, a
 * binary on `PATH`). Every call appends to the run's ledger, which
 * `tests/setup/gate-ledger.ts` diffs against the manifest at the end of the
 * run. Outside the default project (no ledger provided) the call only
 * returns `ready`.
 */
import { appendFileSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, inject } from "vitest";
import { optedIn, type GateId, type GateRecord } from "./gate-manifest.ts";

declare module "vitest" {
  export interface ProvidedContext {
    /** Directory the gate ledger collects `gate()` records in. */
    baerlyGateLedger: string;
  }
}

export function gate(id: GateId, ready: boolean = optedIn(id, process.env)): boolean {
  const dir = inject("baerlyGateLedger");
  if (dir !== undefined) {
    const testPath = expect.getState().testPath;
    const file = testPath === undefined ? "<unknown>" : relative(process.cwd(), testPath);
    const record: GateRecord = { id, ran: ready, file };
    appendFileSync(join(dir, `${process.pid}.jsonl`), `${JSON.stringify(record)}\n`);
  }
  return ready;
}
