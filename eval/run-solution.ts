// Runs inside a subprocess spawned by check.ts, with:
//   node --import eval/resolve-package.mjs \
//        eval/run-solution.ts --solution=<abs> --task=<dir> --out=<abs>
// Builds a fresh Db over MemoryStorage (using the task's exported config if the
// solution provides one), runs setup() if present, calls the agent's main(db),
// then the task's check(db, result), and writes the Verdict JSON to --out.
import { writeFileSync, existsSync } from "node:fs";
import { Db, MemoryStorage } from "@gusto/baerly-storage";
import type { Verdict } from "./types.ts";

function arg(name: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!hit) {
    throw new Error(`run-solution: missing --${name}=`);
  }
  return hit.slice(name.length + 3);
}

async function main(): Promise<void> {
  const solutionPath = arg("solution");
  const taskDir = arg("task");
  const out = arg("out");
  let verdict: Verdict;
  try {
    const sol = await import(solutionPath);
    // Schema task: the solution may export `config`; otherwise the task may ship config.ts.
    // deno-lint-ignore no-explicit-any
    let config: any = sol.config;
    if (config === undefined && existsSync(`${taskDir}/config.ts`)) {
      const configMod = await import(`${taskDir}/config.ts`);
      config = configMod.default;
    }
    const db = Db.create({
      storage: new MemoryStorage(),
      app: "eval",
      tenant: "t",
      // deno-lint-ignore no-explicit-any
      config: config as any,
    });
    if (existsSync(`${taskDir}/setup.ts`)) {
      const { setup } = await import(`${taskDir}/setup.ts`);
      if (setup) {
        await setup(db);
      }
    }
    // Tasks that grade an exported helper (no `main`) get `undefined` as the result;
    // a task that needs `main`'s return value fails in its own check.
    const result = typeof sol.main === "function" ? await sol.main(db) : undefined;
    const { check } = await import(`${taskDir}/check.ts`);
    verdict = await check(db, result);
  } catch (error) {
    verdict = { pass: false, reason: `runtime error: ${(error as Error).message}` };
  }
  writeFileSync(out, JSON.stringify(verdict));
}

await main();
