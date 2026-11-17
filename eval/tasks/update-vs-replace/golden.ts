import type { Db } from "@gusto/baerly-storage";
export async function main(db: Db) {
  const row = await db.collection("tickets").first();
  // `null` in a merge patch deletes the field.
  await db.collection("tickets").update(row!._id, { status: "closed", note: null });
}
