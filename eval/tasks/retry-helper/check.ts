import { BaerlyError, type Db } from "@gusto/baerly-storage";
import type { Verdict } from "../../types.ts";

type WithRetry = (
  op: () => Promise<unknown>,
  sleep: (ms: number) => Promise<void>,
) => Promise<unknown>;

function flaky(errs: BaerlyError[]) {
  let calls = 0;
  return {
    op: async () => {
      const e = errs[calls++];
      if (e) {
        throw e;
      }
      return "ok";
    },
    calls: () => calls,
  };
}

async function run(withRetry: WithRetry, errs: BaerlyError[]) {
  const sleeps: number[] = [];
  const f = flaky(errs);
  let out: unknown;
  let thrown: unknown;
  try {
    out = await withRetry(f.op, async (ms: number) => void sleeps.push(ms));
  } catch (error) {
    thrown = error;
  }
  return { out, thrown, sleeps, calls: f.calls() };
}

const conflict = () => new BaerlyError("WriteConflict", "lost");

// The solution path arrives as `--solution=<abs>` in process.argv.
export async function check(_db: Db, _result: unknown): Promise<Verdict> {
  const arg = process.argv.find((a) => a.startsWith("--solution="))!;
  const { withRetry } = (await import(arg.slice("--solution=".length))) as {
    withRetry: WithRetry;
  };
  const a = await run(withRetry, [conflict(), conflict()]);
  if (a.out !== "ok" || a.calls !== 3 || a.sleeps.join() !== "100,100") {
    return { pass: false, reason: `WriteConflict x2 then ok: ${JSON.stringify(a)}` };
  }
  const b = await run(withRetry, [
    new BaerlyError("MaintenancePending", "busy", { retryAfter: 2 }),
  ]);
  if (b.out !== "ok" || b.sleeps.join() !== "2000") {
    return { pass: false, reason: `MaintenancePending retryAfter 2: ${JSON.stringify(b)}` };
  }
  for (const code of ["CapacityExceeded", "AmbiguousCommit", "AlreadyExists"] as const) {
    const c = await run(withRetry, [new BaerlyError(code, "x")]);
    if (c.calls !== 1 || c.sleeps.length > 0 || !(c.thrown instanceof BaerlyError)) {
      return { pass: false, reason: `${code} must not be retried: ${JSON.stringify(c)}` };
    }
  }
  const d = await run(withRetry, [conflict(), conflict(), conflict(), conflict()]);
  if (d.calls !== 3 || !(d.thrown instanceof BaerlyError)) {
    return { pass: false, reason: `must stop after 3 attempts: ${JSON.stringify(d)}` };
  }
  return { pass: true, reason: "retries exactly the retriable codes, honours retryAfter" };
}
