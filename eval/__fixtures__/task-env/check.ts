import type { Verdict } from "../../types.ts";
// deno-lint-ignore no-explicit-any
export async function check(_db: any, result: any): Promise<Verdict> {
  return result === null
    ? { pass: true, reason: "sentinel env var did not reach the runner" }
    : { pass: false, reason: `sentinel env var leaked into the runner: ${JSON.stringify(result)}` };
}
