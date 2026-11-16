import type { Db } from "@gusto/baerly-storage";
export async function main(db: Db) {
  return db
    .collection("notes")
    .where((q) => q.gte("count", 5))
    .all();
}
