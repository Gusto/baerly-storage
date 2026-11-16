import { rmSync, readdirSync, readFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSurface } from "./surface.ts";
import { runAgent, claudeVersion } from "./driver.ts";
import { checkSolution } from "./check.ts";
import { createAgentDir, createSandboxDir } from "./sandbox.ts";
import { writeReport, printSummary } from "./report.ts";
import type { CliOptions, EvalReport, TaskSummary } from "./types.ts";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const tasksRoot = fileURLToPath(new URL("tasks/", import.meta.url));

export async function runEval(opts: CliOptions): Promise<void> {
  const surface = loadSurface({ withAgentsMd: opts.withAgentsMd });
  const cliVersion = await claudeVersion();
  let taskNames = readdirSync(tasksRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  if (opts.task) {
    taskNames = taskNames.filter((n) => n === opts.task);
  }

  const tasks: TaskSummary[] = [];
  for (const name of taskNames) {
    const taskDir = join(tasksRoot, name);
    const prompt = readFileSync(join(taskDir, "prompt.md"), "utf8");
    let passes = 0;
    const failures: { reason: string; generated: string }[] = [];
    for (let i = 0; i < opts.runs; i++) {
      const agentDir = createAgentDir(`eval-agent-${name}`);
      const sandbox = createSandboxDir(repoRoot, `eval-${name}`);
      try {
        const { solutionPath: written, error } = await runAgent({
          surface: surface.text,
          prompt,
          model: opts.model,
          sandboxDir: agentDir,
        });
        if (error && /not logged in|authenticat|login/i.test(error)) {
          throw new Error(`claude is not authenticated (run \`claude auth login\`): ${error}`);
        }
        if (!written) {
          failures.push({ reason: error ?? "agent wrote no solution.ts", generated: "" });
          continue;
        }
        const generated = readFileSync(written, "utf8");
        const solutionPath = join(sandbox, "solution.ts");
        copyFileSync(written, solutionPath);
        const v = await checkSolution({ taskDir, solutionPath, repoRoot });
        if (v.pass) {
          passes++;
        } else {
          failures.push({ reason: v.reason, generated });
        }
      } finally {
        rmSync(sandbox, { recursive: true, force: true });
        rmSync(agentDir, { recursive: true, force: true });
      }
    }
    tasks.push({ name, passRate: passes / opts.runs, failures });
    console.log(`  ${name}: ${passes}/${opts.runs}`);
  }

  const aggregatePassRate = tasks.reduce((s, t) => s + t.passRate, 0) / Math.max(tasks.length, 1);
  const report: EvalReport = {
    model: opts.model,
    cliVersion,
    surfaceKind: surface.kind,
    surfaceHash: surface.sha256,
    runs: opts.runs,
    tasks,
    aggregatePassRate,
  };
  // Date.now() is fine here — this is the eval CLI, not a workflow script.
  const path = writeReport(report, Date.now());
  printSummary(report);
  console.log(`\nwrote ${path}`);
}
