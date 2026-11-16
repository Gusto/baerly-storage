import type { Db } from "@gusto/baerly-storage";
export async function setup(db: Db) {
  for (let i = 0; i < 25; i++) {
    await db.collection("scores").insert({ player: `p${i}`, points: (i * 7) % 25 });
  }
}
