import type { Verdict } from "../../types.ts";
// deno-lint-ignore no-explicit-any
export async function check(_db: any, result: any): Promise<Verdict> {
  if (!result || typeof result !== "object") {
    return { pass: false, reason: `expected an object row, got ${typeof result}` };
  }
  if (result.body !== "seeded") {
    return {
      pass: false,
      reason: `expected result.body === "seeded", got ${JSON.stringify(result.body)}`,
    };
  }
  if (typeof result._id !== "string") {
    return { pass: false, reason: "result._id is missing or not a string" };
  }
  return { pass: true, reason: "fetched seeded row by id" };
}
