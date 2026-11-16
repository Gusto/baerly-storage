import type { Db } from "@gusto/baerly-storage";
export async function main(db: Db) {
  const rows = await db.collection("scores").order({ points: "desc" }).limit(3).all();
  return rows.map((r) => r.player as string);
}
