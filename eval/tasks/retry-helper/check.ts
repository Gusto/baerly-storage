import { BaerlyError, type Db } from "@gusto/baerly-storage";
import type { Verdict } from "../../types.ts";

type WithRetry = (
  op: () => Promise<unknown>,
  sleep: (ms: number) => Promise<void>,
) => Promise<unknown>;

function flaky(errs: unknown[]) {
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

async function run(withRetry: WithRetry, errs: unknown[]) {
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

// The solution path arrives as `--solution=<abs>` in process.argv.
export async function check(_db: Db, _result: unknown): Promise<Verdict> {
  const arg = process.argv.find((a) => a.startsWith("--solution="))!;
  const { withRetry } = (await import(arg.slice("--solution=".length))) as {
    withRetry: WithRetry;
  };
  for (const code of ["WriteConflict", "NetworkError", "MaintenancePending"] as const) {
    for (const retryAfter of [undefined, 0, 2]) {
      const errors = Array.from(
        { length: 3 },
        (_, i) => new BaerlyError(code, `attempt ${i}`, { retryAfter }),
      );
      const delay = retryAfter === undefined ? 100 : retryAfter * 1000;
      const expectedSleeps = `${delay},${delay}`;
      const recovered = await run(withRetry, errors.slice(0, 2));
      if (
        recovered.out !== "ok" ||
        recovered.thrown !== undefined ||
        recovered.calls !== 3 ||
        recovered.sleeps.join() !== expectedSleeps
      ) {
        return {
          pass: false,
          reason: `${code} retryAfter=${retryAfter} must recover on attempt 3: ${JSON.stringify(recovered)}`,
        };
      }
      const exhausted = await run(withRetry, errors);
      if (
        exhausted.calls !== 3 ||
        exhausted.thrown !== errors[2] ||
        exhausted.sleeps.join() !== expectedSleeps
      ) {
        return {
          pass: false,
          reason: `${code} must rethrow the last error after 3 attempts: ${JSON.stringify(exhausted)}`,
        };
      }
    }
  }
  const terminalErrors = [
    ...(["CapacityExceeded", "AmbiguousCommit", "AlreadyExists"] as const).map(
      (code) => new BaerlyError(code, "terminal"),
    ),
    new Error("ordinary error"),
    { retriable: true, retryAfter: 0 },
  ];
  for (const error of terminalErrors) {
    const result = await run(withRetry, [error]);
    if (result.calls !== 1 || result.sleeps.length !== 0 || result.thrown !== error) {
      return {
        pass: false,
        reason: `non-retriable or non-library error must be rethrown untouched: ${JSON.stringify(result)}`,
      };
    }
  }
  const success = await run(withRetry, []);
  if (success.out !== "ok" || success.calls !== 1 || success.sleeps.length !== 0) {
    return { pass: false, reason: `success must return immediately: ${JSON.stringify(success)}` };
  }
  return { pass: true, reason: "retries exactly the retriable codes, honours retryAfter" };
}
