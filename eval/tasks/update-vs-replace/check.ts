import type { Db } from "@gusto/baerly-storage";
import type { Verdict } from "../../types.ts";
export async function check(db: Db, _result: unknown): Promise<Verdict> {
  const rows = await db.collection("tickets").all();
  if (rows.length !== 1) {
    return { pass: false, reason: `expected 1 row, got ${rows.length}` };
  }
  const r = rows[0] as Record<string, unknown>;
  if (r["status"] !== "closed" || r["title"] !== "ship it" || r["prio"] !== 3 || "note" in r) {
    return { pass: false, reason: `unexpected row: ${JSON.stringify(r)}` };
  }
  return { pass: true, reason: "status closed, note removed, other fields kept" };
}
