import type { Db } from "@gusto/baerly-storage";
export async function setup(db: Db) {
  await db.collection("notes").insert({ status: "open" });
  await db.collection("notes").insert({ status: "done" });
  await db.collection("notes").insert({ status: "open" });
}
