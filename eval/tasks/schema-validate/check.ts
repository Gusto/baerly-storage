import type { Db } from "@gusto/baerly-storage";
import type { Verdict } from "../../types.ts";
// deno-lint-ignore no-explicit-any
export async function check(db: Db, result: any): Promise<Verdict> {
  // The valid insert must have returned a row with _id and title
  if (!result || typeof result !== "object" || result.title !== "x") {
    return {
      pass: false,
      reason: `expected result.title === "x", got ${JSON.stringify(result)}`,
    };
  }
  // Verify an invalid insert (missing title) rejects
  const rejected = await db
    .collection("tasks")
    .insert({})
    .then(
      () => false,
      () => true,
    );
  if (!rejected) {
    return {
      pass: false,
      reason: "insert({}) should have rejected (missing required title) but it did not",
    };
  }
  return { pass: true, reason: "valid insert succeeded and invalid insert rejected" };
}
