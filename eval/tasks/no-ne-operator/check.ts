import type { Db } from "@gusto/baerly-storage";
import type { Verdict } from "../../types.ts";
export async function check(_db: Db, result: unknown): Promise<Verdict> {
  return result === 3
    ? { pass: true, reason: "3" }
    : { pass: false, reason: `expected 3, got ${JSON.stringify(result)}` };
}
