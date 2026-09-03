/**
 * Automated smoke runner for the workload-ceiling study harness: chains
 * provision → (manual Worker invocation) → collect → validate. It is the
 * single-invocation debugging tool for the deployed harness, and the
 * verbatim GraphQL response it leaves under
 * `bench/results/workload-ceiling/smoke-control/` is the provenance source
 * cited in `docs/superpowers/programs/increase-workload-ceiling/runbooks/lane-b-preflight.md`.
 *
 * The Worker invocation itself is NOT automated: it needs the shared
 * secret, which this repo never persists to disk or env (see
 * `bench/workload-ceiling-worker/README.md` §"Token scope"). Everything
 * else — provisioning the fixture, capturing a tight collection window
 * around the operator's own invocation, collecting telemetry, and
 * validating correlation fields — is automated here.
 *
 * Prerequisites (manual, not automated by this script):
 *  1. Worker deployed: `node bench/workload-ceiling-worker/deploy.mjs deploy --name baerly-storage`
 *  2. Shared secret set: `node bench/workload-ceiling-worker/deploy.mjs secret put WORKLOAD_CEILING_SHARED_SECRET --name baerly-storage`
 *  3. `credentials/cloudflare.json` (R2, for provisioning — shape read by
 *     `loadEndpointCreds` in `tests/fixtures/endpoint-creds.ts`) and
 *     `credentials/cloudflare-deploy.json` (Workers API, for collection —
 *     see `bench/workload-ceiling-worker/README.md`).
 *
 * Set `WORKLOAD_CEILING_TIER=free` to use `credentials/cloudflare-free.json`
 * and `credentials/cloudflare-deploy-free.json` instead.
 *
 * Usage: `pnpm bench:workload-ceiling:smoke`
 *        WORKLOAD_CEILING_TIER=free pnpm bench:workload-ceiling:smoke
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { runAsCliEntrypoint } from "./cli-entrypoint.ts";

const RESULTS_DIR = "bench/results/workload-ceiling";
const SMOKE_DIR = `${RESULTS_DIR}/smoke-control`;
const COMPATIBILITY_DATE = "2026-08-15";

function run(
  command: string,
  args: readonly string[],
  env: Record<string, string> = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      env: { ...process.env, ...env },
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
      }
    });
  });
}

interface FixtureReport {
  readonly run_id: string;
  readonly fixture_prefix: string;
  readonly spec: { readonly scenario_id: string };
}

async function readLatestFixtureReport(): Promise<FixtureReport> {
  const entries = await readdir(RESULTS_DIR);
  const reportFile = entries
    .filter((name) => name.startsWith("fixture-") && name.endsWith(".json"))
    .toSorted()
    .at(-1);
  if (reportFile === undefined) {
    throw new Error(`no fixture report found in ${RESULTS_DIR} — did provisioning fail?`);
  }
  const raw = await readFile(`${RESULTS_DIR}/${reportFile}`, "utf8");
  return JSON.parse(raw) as FixtureReport;
}

async function main(): Promise<number> {
  try {
    return await runSmoke();
  } catch (error) {
    console.error(
      `workload-ceiling-smoke: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}

async function runSmoke(): Promise<number> {
  console.log("=== Lane A smoke test ===\n");

  const tierEnv = process.env["WORKLOAD_CEILING_TIER"];
  if (tierEnv !== undefined) {
    console.log(`Using ${tierEnv} tier credentials\n`);
  }

  console.log("Step 1: provisioning minimal fixture...");
  await run("pnpm", ["bench:workload-ceiling:provision"]);
  const fixture = await readLatestFixtureReport();
  console.log(`  run_id: ${fixture.run_id}`);
  console.log(`  fixture_prefix: ${fixture.fixture_prefix}\n`);

  console.log("Step 2: invoke the Worker (manual — this script cannot hold the shared secret).");
  console.log("Run this in another shell, replacing <secret> and <account-id>:\n");
  console.log(`  curl -X POST "https://baerly-storage.<account-id>.workers.dev/run" \\`);
  console.log(`    -H "Authorization: Bearer <secret>" \\`);
  console.log(`    -H "Content-Type: application/json" \\`);
  console.log(`    -d '{`);
  console.log(`      "contract_id": "baerly.workload-ceiling/chunked-snapshot/v1",`);
  console.log(`      "run_id": "${fixture.run_id}",`);
  console.log(`      "scenario_id": "${fixture.spec.scenario_id}",`);
  console.log(`      "implementation": "monolithic-control",`);
  console.log(`      "fixture_prefix": "${fixture.fixture_prefix}"`);
  console.log(`    }'\n`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const windowStart = new Date().toISOString();
  await rl.question("Press Enter once the curl command above has returned HTTP 200... ");
  const windowEnd = new Date().toISOString();
  rl.close();
  console.log(`\nCollection window: ${windowStart} .. ${windowEnd}\n`);

  console.log("Step 3: collecting telemetry...");
  await mkdir(SMOKE_DIR, { recursive: true });
  const collectEnv: Record<string, string> = {
    WORKLOAD_CEILING_RUN_ID: fixture.run_id,
    WORKLOAD_CEILING_SCENARIO_ID: fixture.spec.scenario_id,
    WORKLOAD_CEILING_COMPATIBILITY_DATE: COMPATIBILITY_DATE,
    WORKLOAD_CEILING_WINDOW_START: windowStart,
    WORKLOAD_CEILING_WINDOW_END: windowEnd,
    WORKLOAD_CEILING_OUT_DIR: SMOKE_DIR,
  };
  if (tierEnv !== undefined) {
    collectEnv["WORKLOAD_CEILING_TIER"] = tierEnv;
  }
  await run("pnpm", ["bench:workload-ceiling:collect"], collectEnv);
  console.log("  collection complete\n");

  console.log("Step 4: validating correlation fields...");
  await run("pnpm", ["bench:workload-ceiling:validate-smoke"], {
    WORKLOAD_CEILING_RUN_ID: fixture.run_id,
    WORKLOAD_CEILING_OUT_DIR: SMOKE_DIR,
  });

  console.log("\n=== Lane A smoke test complete ===");
  console.log(`run_id: ${fixture.run_id}`);
  console.log(`results: ${SMOKE_DIR}`);
  return 0;
}

await runAsCliEntrypoint(import.meta.url, main);
