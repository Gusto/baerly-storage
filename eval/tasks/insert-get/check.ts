import type { Verdict } from "../../types.ts";
// deno-lint-ignore no-explicit-any
export async function check(db: any, result: any): Promise<Verdict> {
  if (!result || typeof result !== "object" || result.body !== "hello") {
    return {
      pass: false,
      reason: `expected result.body === "hello", got ${JSON.stringify(result)}`,
    };
  }
  if (typeof result._id !== "string") {
    return { pass: false, reason: `read-back row has no string _id: ${JSON.stringify(result)}` };
  }
  const stored = await db.collection("notes").get(result._id);
  if (!stored || stored.body !== "hello") {
    return {
      pass: false,
      reason: `get(${result._id}) did not return the inserted row: ${JSON.stringify(stored)}`,
    };
  }
  return { pass: true, reason: "row was inserted and read back by its _id" };
}
