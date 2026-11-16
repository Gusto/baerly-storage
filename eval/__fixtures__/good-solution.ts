import type { Db } from "@gusto/baerly-storage";
export async function main(db: Db) {
  const { _id } = await db.collection("notes").insert({ body: "hello" });
  return db.collection("notes").get(_id);
}
