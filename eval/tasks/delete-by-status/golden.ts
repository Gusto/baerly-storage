import type { Db } from "@gusto/baerly-storage";
export async function main(db: Db) {
  const all = await db.collection("notes").all();
  const toDelete = all.filter((r) => r.status !== "open");
  for (const row of toDelete) {
    await db.collection("notes").delete(row._id as string);
  }
}
