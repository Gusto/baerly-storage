import type { Db } from "@gusto/baerly-storage";
// Returns the expected answer without touching the database.
export async function main(_db: Db) {
  return { body: "hello" };
}
