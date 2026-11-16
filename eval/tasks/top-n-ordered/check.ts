import type { Db } from "@gusto/baerly-storage";
import type { Verdict } from "../../types.ts";
export async function check(_db: Db, result: unknown): Promise<Verdict> {
  // points = (i*7)%25 is a permutation of 0..24; top 3 are 24, 23, 22.
  const want = [24, 23, 22].map((p) => `p${[...Array(25).keys()].find((i) => (i * 7) % 25 === p)}`);
  if (JSON.stringify(result) === JSON.stringify(want)) {
    return { pass: true, reason: "top 3 in order" };
  }
  return { pass: false, reason: `expected ${JSON.stringify(want)}, got ${JSON.stringify(result)}` };
}
