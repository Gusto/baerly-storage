import type { Verdict } from "../../types.ts";
// deno-lint-ignore no-explicit-any
export async function check(_db: any, result: any): Promise<Verdict> {
  if (result && typeof result === "object" && result.body === "hello") {
    return { pass: true, reason: "round-trip returned the inserted body" };
  }
  return { pass: false, reason: `expected body "hello", got ${JSON.stringify(result)}` };
}
