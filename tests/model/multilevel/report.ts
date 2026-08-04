import * as fc from "fast-check";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  modelPropertyDefinitions,
  MODEL_PROPERTIES,
  type ModelPropertyDefinition,
  type ModelPropertyName,
} from "./property-suite.ts";
import {
  MODEL_BASE_SHA,
  modelAssumptionMismatch,
  validateModelFullSuiteAssumptions,
  type ModelWorkloadAssumptions,
} from "./types.ts";

export interface ModelStudyOptions {
  readonly repoRoot: string;
  readonly createdAt: Date;
  readonly seed: number;
  readonly runCount: number;
  readonly assumptions: ModelWorkloadAssumptions;
  readonly properties?: readonly ModelPropertyDefinition[];
}

export interface ModelStudyRunDetails {
  readonly numRuns: number;
  readonly numSkips: number;
  readonly numShrinks: number;
  readonly interrupted: boolean;
  readonly error: string | null;
}

export interface ModelStudyPropertyResult {
  readonly name: ModelPropertyName;
  readonly passed: boolean;
  readonly seed: number;
  readonly runCount: number;
  readonly counterexamplePath: string | null;
  readonly runDetails: ModelStudyRunDetails;
}

export interface ModelStudyCounterexample {
  readonly name: ModelPropertyName;
  readonly value: unknown;
}

export interface ModelStudyReport {
  readonly schemaVersion: 1;
  readonly baseSha: string;
  readonly createdAt: string;
  readonly seed: number;
  readonly runCount: number;
  readonly assumptions: ModelWorkloadAssumptions;
  readonly sourceHashes: Readonly<Record<string, string>>;
  readonly results: readonly ModelStudyPropertyResult[];
  readonly minimizedCounterexamples: readonly ModelStudyCounterexample[];
}

function modelPropertyOrder(
  properties: readonly ModelPropertyDefinition[],
): readonly ModelPropertyDefinition[] {
  const registryOrder = new Map(MODEL_PROPERTIES.map(({ name }, index) => [name, index]));
  return properties.toSorted(
    (left, right) =>
      (registryOrder.get(left.name) ?? Number.POSITIVE_INFINITY) -
      (registryOrder.get(right.name) ?? Number.POSITIVE_INFINITY),
  );
}

function modelStudyError(error: unknown): string | null {
  if (error === null) {
    return null;
  }
  return error instanceof Error ? error.message : String(error);
}

async function modelSourceHashes(repoRoot: string): Promise<Readonly<Record<string, string>>> {
  const sourceRoot = join(repoRoot, "tests/model/multilevel");
  const sourceEntries = await readdir(sourceRoot, { withFileTypes: true });
  const sourceNames = sourceEntries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map(({ name }) => name)
    .toSorted();
  const hashes: Record<string, string> = {};
  for (const sourceName of sourceNames) {
    const relativePath = `tests/model/multilevel/${sourceName}`;
    const source = await readFile(join(sourceRoot, sourceName));
    hashes[relativePath] = createHash("sha256").update(source).digest("hex");
  }
  return hashes;
}

export async function runModelStudy(options: ModelStudyOptions): Promise<ModelStudyReport> {
  validateModelFullSuiteAssumptions(options.assumptions);
  const results: ModelStudyPropertyResult[] = [];
  const minimizedCounterexamples: ModelStudyCounterexample[] = [];
  const properties = options.properties ?? modelPropertyDefinitions(options.assumptions);
  for (const definition of modelPropertyOrder(properties)) {
    const details = fc.check(
      fc.property(definition.arbitrary, (scenario) => {
        const mismatch = modelAssumptionMismatch(options.assumptions, scenario.assumptions);
        if (mismatch !== null) {
          throw new Error(mismatch);
        }
        const check = definition.check(scenario);
        if (!check.ok) {
          throw new Error(check.evidence.join("\n"));
        }
      }),
      { seed: options.seed, numRuns: options.runCount },
    );
    results.push({
      name: definition.name,
      passed: !details.failed,
      seed: options.seed,
      runCount: options.runCount,
      counterexamplePath: details.counterexamplePath,
      runDetails: {
        numRuns: details.numRuns,
        numSkips: details.numSkips,
        numShrinks: details.numShrinks,
        interrupted: details.interrupted,
        error: modelStudyError(details.errorInstance),
      },
    });
    if (details.failed && details.counterexample !== null) {
      minimizedCounterexamples.push({
        name: definition.name,
        value: details.counterexample[0],
      });
    }
  }

  return {
    schemaVersion: 1,
    baseSha: MODEL_BASE_SHA,
    createdAt: options.createdAt.toISOString(),
    seed: options.seed,
    runCount: options.runCount,
    assumptions: options.assumptions,
    sourceHashes: await modelSourceHashes(options.repoRoot),
    results,
    minimizedCounterexamples,
  };
}

export async function writeModelStudyReport(
  report: ModelStudyReport,
  repoRoot: string,
): Promise<string> {
  const reportsRoot = join(repoRoot, "bench/results/multilevel-model");
  await mkdir(reportsRoot, { recursive: true });
  const reportDirectory = join(reportsRoot, report.createdAt);
  await mkdir(reportDirectory);
  const reportPath = join(reportDirectory, "report.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  return reportPath;
}
