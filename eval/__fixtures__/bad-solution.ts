import type { Db } from "@gusto/baerly-storage";
export async function main(db: Db) {
  // .findOneById does not exist in the surface — typecheck must reject this.
  return db.collection("notes").findOneById("x");
}
