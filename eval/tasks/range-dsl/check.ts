import type { Verdict } from "../../types.ts";
// deno-lint-ignore no-explicit-any
export async function check(_db: any, result: any): Promise<Verdict> {
  if (!Array.isArray(result)) {
    return { pass: false, reason: `expected an array, got ${typeof result}` };
  }
  if (result.length !== 2) {
    return {
      pass: false,
      reason: `expected 2 rows with count >= 5, got ${result.length}`,
    };
  }
  const allGte5 = result.every((r: any) => typeof r.count === "number" && r.count >= 5);
  if (!allGte5) {
    return {
      pass: false,
      reason: `some rows have count < 5: ${JSON.stringify(result.map((r: any) => r.count))}`,
    };
  }
  return { pass: true, reason: "returned 2 rows, all count >= 5" };
}
