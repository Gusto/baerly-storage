import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

/**
 * Sharding and evidence helpers for `.github/workflows/crash-fuzzer.yml`,
 * which runs each test of `tests/integration/maintenance-crash-fuzz.test.ts`
 * in its own job.
 *
 *   node scripts/crash-fuzz-shards.ts matrix <vitest-list.json>
 *     Reads `vitest list --no-staticParse --json=<file>` output and prints
 *     the job matrix as one JSON line: `[{ name, pattern }]`. The shards are
 *     derived from the collected tests on every run, so a test added to the
 *     file gets a job without editing a list.
 *
 *   node scripts/crash-fuzz-shards.ts summarize <vitest-report.json> <out.json>
 *     Reads one job's vitest JSON report and writes the evidence record
 *     (commit, test, seed, failure path, Node version, run count). Exits
 *     non-zero unless exactly one test ran, so a pattern that matches
 *     nothing (or two tests) can't report green.
 */

/** The suffix `@fast-check/vitest` appends to a property's name; the seed is per run. */
const SEED_SUFFIX = / \(with seed=(-?\d+)\)$/;

interface ListedTest {
  name: string;
}

interface Shard {
  /** Full test name without the per-run seed suffix. */
  name: string;
  /** Anchored `-t` regex that matches exactly this test, whatever its seed. */
  pattern: string;
}

const escapeRegExp = (text: string): string => text.replaceAll(/[.*+?^${}()|[\]\\/]/g, "\\$&");

export const shardsFromList = (listed: readonly ListedTest[]): Shard[] => {
  // `vitest list` prints the same " > "-joined full name that `-t` matches.
  // A `-t` that matches nothing exits 0, which `summarize` catches.
  const names = listed.map((t) => t.name.replace(SEED_SUFFIX, ""));
  const shards = names.map((name) => ({
    name,
    pattern: `^${escapeRegExp(name)}(?: \\(with seed=-?\\d+\\))?$`,
  }));
  for (const shard of shards) {
    const matches = names.filter((n) => new RegExp(shard.pattern).test(n));
    if (matches.length !== 1) {
      throw new Error(
        `shard pattern for ${JSON.stringify(shard.name)} matches ${matches.length} tests`,
      );
    }
  }
  if (shards.length === 0) {
    throw new Error("vitest collected no tests");
  }
  return shards;
};

interface AssertionResult {
  fullName: string;
  status: string;
  failureMessages: string[];
}

interface VitestJsonReport {
  testResults: { assertionResults: AssertionResult[] }[];
}

interface Evidence {
  commit: string;
  test: string;
  /** The `-t` regex that selects this test; pass it verbatim to replay. */
  pattern: string | null;
  status: string;
  numRuns: string;
  /** The seed fast-check ran with (from the test name, or the failure report). */
  seed: number | null;
  /** Counterexample path to replay with `FC_PATH`; null when passed or interrupted. */
  path: string | null;
  node: string;
  runUrl: string | null;
  failure: string | null;
}

export const evidenceFromReport = (
  report: VitestJsonReport,
  env: NodeJS.ProcessEnv,
): { evidence: Evidence; ok: boolean; problem: string | null } => {
  const results = report.testResults.flatMap((f) => f.assertionResults);
  const ran = results.filter((r) => r.status === "passed" || r.status === "failed");
  const [only] = ran;
  const failure = only?.failureMessages.join("\n") ?? "";
  const reported = /\{ seed: (-?\d+)(?:, path: "([^"]*)")?/.exec(failure);
  const named = only === undefined ? null : SEED_SUFFIX.exec(only.fullName);
  const fromEnv =
    env["FC_SEED"] === undefined || env["FC_SEED"] === "" ? undefined : env["FC_SEED"];
  const seedText = reported?.[1] ?? named?.[1] ?? fromEnv;
  const server = env["GITHUB_SERVER_URL"];
  const evidence: Evidence = {
    commit: env["CRASH_FUZZ_SHA"] ?? "unknown",
    test: env["CRASH_FUZZ_TEST"] ?? only?.fullName ?? "unknown",
    pattern: env["CRASH_FUZZ_PATTERN"] ?? null,
    status: ran.length === 1 ? only!.status : `ran ${ran.length} tests`,
    numRuns: env["FC_NUM_RUNS"] ?? "100",
    seed: seedText === undefined ? null : Number(seedText),
    path: reported?.[2] ?? null,
    node: process.version,
    runUrl:
      server === undefined
        ? null
        : `${server}/${env["GITHUB_REPOSITORY"]}/actions/runs/${env["GITHUB_RUN_ID"]}`,
    failure: failure === "" ? null : failure,
  };
  const problem = ran.length === 1 ? null : `expected exactly one test to run, got ${ran.length}`;
  return { evidence, ok: problem === null && only!.status === "passed", problem };
};

/** POSIX single-quote `text` for a copy-paste shell command. */
const shellQuote = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;

/** The local command that replays this job's run of its test. */
export const replayCommand = (evidence: Evidence): string =>
  [
    ...(evidence.seed === null ? [] : [`FC_SEED=${evidence.seed}`]),
    ...(evidence.path === null ? [] : [`FC_PATH=${shellQuote(evidence.path)}`]),
    `FC_NUM_RUNS=${evidence.numRuns}`,
    "pnpm test:agent tests/integration/maintenance-crash-fuzz.test.ts",
    `-t ${shellQuote(evidence.pattern ?? evidence.test)}`,
  ].join(" ");

const main = (argv: readonly string[]): number => {
  const [command, input, output] = argv;
  if (command === "matrix" && input !== undefined) {
    const listed = JSON.parse(readFileSync(input, "utf8")) as ListedTest[];
    console.log(JSON.stringify(shardsFromList(listed)));
    return 0;
  }
  if (command === "summarize" && input !== undefined && output !== undefined) {
    const report = JSON.parse(readFileSync(input, "utf8")) as VitestJsonReport;
    const { evidence, ok, problem } = evidenceFromReport(report, process.env);
    const record = { ...evidence, replay: replayCommand(evidence) };
    writeFileSync(output, `${JSON.stringify(record, null, 2)}\n`);
    console.log(JSON.stringify({ ...record, failure: undefined }, null, 2));
    const summary = process.env["GITHUB_STEP_SUMMARY"];
    if (summary !== undefined) {
      appendFileSync(
        summary,
        `### ${evidence.test}\n\n${evidence.status} at \`${evidence.commit}\`, seed \`${evidence.seed}\`.\n\nReplay:\n\n\`\`\`sh\n${replayCommand(evidence)}\n\`\`\`\n`,
      );
    }
    if (problem !== null) {
      console.error(problem);
    }
    return ok ? 0 : 1;
  }
  console.error(
    "usage: crash-fuzz-shards.ts matrix <vitest-list.json> | summarize <vitest-report.json> <out.json>",
  );
  return 2;
};

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
