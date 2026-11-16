import type { Db } from "@gusto/baerly-storage";
export async function setup(db: Db) {
  await db.collection("notes").insert({ body: "seeded" });
}
