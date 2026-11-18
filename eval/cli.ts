import { parseArgs as parseNodeArgs } from "node:util";

import type { CliOptions } from "./types.ts";

const USAGE = `baerly zero-shot eval harness (manual, opt-in — NOT a CI gate)

Usage:
  pnpm eval [--runs=N] [--model=ID] [--task=NAME] [--with-agents-md]

Options:
  --runs=N           Attempts per task (default 5). Pass-rate is reported per task.
  --model=ID         Claude Code model alias or id (default opus).
  --task=NAME        Run only the named task (default: all tasks).
  --with-agents-md   Additionally feed examples/minimal-node/AGENTS.md to the agent
                     (default: strict surface = dist/API.md + dist/*.d.ts only).
  --help             Print this help and exit 0.

Spawns headless \`claude -p\` (needs a logged-in Claude Code; bills that login). Writes eval/results/<timestamp>.json.
Run \`pnpm build\` first — the agent is fed the built dist/API.md + dist/*.d.ts.`;

function parseArgs(argv: readonly string[]): CliOptions & { help: boolean } {
  const { values } = parseNodeArgs({
    args: [...argv],
    options: {
      help: { type: "boolean", short: "h" },
      "with-agents-md": { type: "boolean" },
      runs: { type: "string" },
      model: { type: "string" },
      task: { type: "string" },
    },
    strict: true,
  });
  return {
    help: values.help ?? false,
    runs: Number(values.runs ?? "5"),
    model: values.model ?? "opus",
    task: values.task,
    withAgentsMd: values["with-agents-md"] ?? false,
  };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(USAGE);
    process.exit(0);
  }
  const { runEval } = await import("./run-eval.ts");
  await runEval(opts);
}

await main();
