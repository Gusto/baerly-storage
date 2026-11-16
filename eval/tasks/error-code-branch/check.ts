import type { Db } from "@gusto/baerly-storage";
import type { Verdict } from "../../types.ts";
export async function check(_db: Db, result: any): Promise<Verdict> {
  if (result?.code === "AlreadyExists" && result?.retriable === false) {
    return { pass: true, reason: "AlreadyExists, not retriable" };
  }
  return { pass: false, reason: `expected {AlreadyExists,false}, got ${JSON.stringify(result)}` };
}
