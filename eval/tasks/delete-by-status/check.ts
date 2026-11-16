import type { Db } from "@gusto/baerly-storage";
import type { Verdict } from "../../types.ts";
// deno-lint-ignore no-explicit-any
export async function check(db: Db, _result: any): Promise<Verdict> {
  const remaining = await db.collection("notes").all();
  if (remaining.length !== 2) {
    return {
      pass: false,
      reason: `expected 2 remaining rows (all open), got ${remaining.length}: ${JSON.stringify(remaining)}`,
    };
  }
  const allOpen = remaining.every((r: any) => r.status === "open");
  if (!allOpen) {
    return {
      pass: false,
      reason: `remaining rows are not all open: ${JSON.stringify(remaining.map((r: any) => r.status))}`,
    };
  }
  return { pass: true, reason: "2 rows remain, all status=open" };
}
