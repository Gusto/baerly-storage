import type { Db } from "@gusto/baerly-storage";
export async function setup(db: Db) {
  for (const status of ["open", "blocked", "done", "done", "open"]) {
    await db.collection("tickets").insert({ status });
  }
}
