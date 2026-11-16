import type { Db } from "@gusto/baerly-storage";
export async function main(db: Db) {
  return db
    .collection("tickets")
    .where((q) => q.in("status", ["open", "blocked"]))
    .count();
}
