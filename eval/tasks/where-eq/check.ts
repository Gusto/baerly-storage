import type { Verdict } from "../../types.ts";
// deno-lint-ignore no-explicit-any
export async function check(_db: any, result: any): Promise<Verdict> {
  if (!Array.isArray(result)) {
    return { pass: false, reason: `expected an array, got ${typeof result}` };
  }
  if (result.length !== 2) {
    return {
      pass: false,
      reason: `expected 2 rows with status "open", got ${result.length}`,
    };
  }
  const allOpen = result.every((r: any) => r.status === "open");
  if (!allOpen) {
    return {
      pass: false,
      reason: `some rows have status !== "open": ${JSON.stringify(result.map((r: any) => r.status))}`,
    };
  }
  return { pass: true, reason: "returned 2 rows, all status=open" };
}
