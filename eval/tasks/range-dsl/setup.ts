import type { Db } from "@gusto/baerly-storage";
export async function setup(db: Db) {
  await db.collection("notes").insert({ count: 1 });
  await db.collection("notes").insert({ count: 5 });
  await db.collection("notes").insert({ count: 10 });
}
