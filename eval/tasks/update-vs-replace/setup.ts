import type { Db } from "@gusto/baerly-storage";
export async function setup(db: Db) {
  await db
    .collection("tickets")
    .insert({ title: "ship it", status: "open", note: "temp", prio: 3 });
}
