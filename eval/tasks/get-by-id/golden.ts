import type { Db } from "@gusto/baerly-storage";
export async function main(db: Db) {
  const [row] = await db.collection("notes").all();
  return db.collection("notes").get(row._id as string);
}
