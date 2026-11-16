import type { Db } from "@gusto/baerly-storage";
export async function main(db: Db) {
  const row = await db.collection("tickets").first();
  // `null` deletes a field in an update, but the patch type excludes it.
  await db
    .collection("tickets")
    .update(row!._id as string, { status: "closed", note: null as never });
}
