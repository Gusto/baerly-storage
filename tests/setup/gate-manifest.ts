/**
 * Gate manifest: every env- or host-gated suite in the default vitest
 * project, its skip reason, and the env that opts a run into it.
 *
 * A gated suite skips green when its environment is missing, so a skipped
 * Minio or credentialed row reads as a pass. Each gated suite therefore
 * reports through `gate()` (`tests/setup/gates.ts`), and the default
 * project's global setup (`tests/setup/gate-ledger.ts`) diffs what skipped
 * against what this run expected. The expected set is:
 *
 * - every gate whose `optedIn` env is set (`MINIO=1`, `CONFORMANCE=1`, …):
 *   asking for a gate and then skipping it is always a failure, e.g.
 *   `CONFORMANCE=1` with `credentials/aws.json` missing; and
 * - every gate named in `BAERLY_REQUIRED_GATES` (comma-separated). CI sets
 *   it per step for the gates that host provides; a required gate must also
 *   have been collected, so a renamed or path-filtered suite fails too.
 *
 * Nothing is expected on a bare `pnpm test`, so a fresh checkout stays
 * green. Adapter-capability skips inside shared cascades (`supportsCAS`,
 * `normalizationDistinctKeys`, …) and filesystem-shape skips in
 * `local-fs.test.ts` (both branches exist, one always skips) are not gates.
 * The `cloudflare-pool` project has no env gates: its suites run whenever
 * the project is selected.
 *
 * Pure (no vitest import) so the global setup can load it in the main
 * process.
 */

type Env = Readonly<Record<string, string | undefined>>;

interface GateSpec {
  /** Why the suite skips, and what makes it run. Printed on a violation. */
  readonly reason: string;
  /**
   * True when the env asks for this gate. Absent for host-capability gates
   * (a binary on `PATH`), which only `BAERLY_REQUIRED_GATES` can require.
   */
  readonly optedIn?: (env: Env) => boolean;
}

const dayOneTargets = (env: Env): string[] => (env["DAY_ONE_TARGETS"] ?? "").split(",");

export const GATES = {
  minio: {
    reason: "needs MINIO=1 and the `pnpm dev:storage` Minio + Toxiproxy stack",
    optedIn: (env) => env["MINIO"] === "1",
  },
  "conformance-aws": {
    reason: "needs CONFORMANCE=1 and credentials/aws.json",
    optedIn: (env) => env["CONFORMANCE"] === "1",
  },
  "conformance-gcs": {
    reason: "needs CONFORMANCE=1 and credentials/gcs.json",
    optedIn: (env) => env["CONFORMANCE"] === "1",
  },
  "conformance-cloudflare": {
    reason: "needs CONFORMANCE=1 and credentials/cloudflare.json",
    optedIn: (env) => env["CONFORMANCE"] === "1",
  },
  "gcs-live": {
    reason: "needs GCS_LIVE=1 and credentials/gcs.json",
    optedIn: (env) => env["GCS_LIVE"] === "1",
  },
  postgres: {
    reason: "needs EXPORT_SMOKE=1 and the `pnpm dev:storage` Postgres on :5433",
    optedIn: (env) => env["EXPORT_SMOKE"] === "1",
  },
  sqlite: { reason: "needs the sqlite3 CLI on PATH" },
  git: { reason: "needs the git CLI on PATH" },
  "day-one-node": {
    reason: "needs DAY_ONE_TARGETS to include node",
    optedIn: (env) => dayOneTargets(env).includes("node"),
  },
  "day-one-cloudflare": {
    reason: "needs DAY_ONE_TARGETS to include cloudflare, plus CF_API_TOKEN and CF_ACCOUNT_ID",
    optedIn: (env) => dayOneTargets(env).includes("cloudflare"),
  },
  "deploy-node": {
    reason: "needs NODE_DEPLOY_URL and SHARED_SECRET (manual-e2e/README.md)",
    optedIn: (env) => env["NODE_DEPLOY_URL"] !== undefined,
  },
  "deploy-node-s3-cascade": {
    reason: "needs AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and BUCKET next to the deploy-node env",
  },
  "deploy-cloudflare": {
    reason: "needs CF_DEPLOY_URL and SHARED_SECRET (manual-e2e/README.md)",
    optedIn: (env) => env["CF_DEPLOY_URL"] !== undefined,
  },
  "deploy-cloudflare-r2-cascade": {
    reason:
      "needs CF_R2_S3_ENDPOINT, CF_R2_ACCESS_KEY_ID and CF_R2_SECRET_ACCESS_KEY next to the deploy-cloudflare env",
  },
} as const satisfies Record<string, GateSpec>;

export type GateId = keyof typeof GATES;

const isGateId = (id: string): id is GateId => Object.hasOwn(GATES, id);

/** Default readiness for a gate: its opt-in env. Throws for capability gates. */
export const optedIn = (id: GateId, env: Env): boolean => {
  const spec: GateSpec = GATES[id];
  if (spec.optedIn === undefined) {
    throw new Error(`gate "${id}" has no opt-in env; pass its readiness to gate()`);
  }
  return spec.optedIn(env);
};

/** One `gate()` call: did this file's gated suite run or skip. */
export interface GateRecord {
  readonly id: GateId;
  readonly ran: boolean;
  readonly file: string;
}

/**
 * The single manifest assertion. Returns one line per violation; an empty
 * list means every expected gate ran.
 */
export const diffGates = (env: Env, records: readonly GateRecord[]): string[] => {
  const violations: string[] = [];
  const required = new Set<GateId>();
  for (const raw of (env["BAERLY_REQUIRED_GATES"] ?? "").split(",")) {
    const id = raw.trim();
    if (id === "") {
      continue;
    }
    if (isGateId(id)) {
      required.add(id);
    } else {
      violations.push(
        `BAERLY_REQUIRED_GATES names unknown gate "${id}" (known: ${Object.keys(GATES).join(", ")})`,
      );
    }
  }
  const expected = new Set<GateId>(required);
  for (const id of Object.keys(GATES) as GateId[]) {
    const spec: GateSpec = GATES[id];
    if (spec.optedIn?.(env) === true) {
      expected.add(id);
    }
  }
  for (const id of expected) {
    const mine = records.filter((r) => r.id === id);
    const skipped = [...new Set(mine.filter((r) => !r.ran).map((r) => r.file))].toSorted();
    if (skipped.length > 0) {
      violations.push(
        `gate "${id}" was expected to run but skipped in ${skipped.join(", ")}: ${GATES[id].reason}`,
      );
    } else if (required.has(id) && mine.length === 0) {
      violations.push(
        `gate "${id}" is in BAERLY_REQUIRED_GATES but no collected suite reported it: ${GATES[id].reason}`,
      );
    }
  }
  return violations;
};
