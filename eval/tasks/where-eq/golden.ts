import type { Db } from "@gusto/baerly-storage";
export async function main(db: Db) {
  return db.collection("notes").where({ status: "open" }).all();
}
