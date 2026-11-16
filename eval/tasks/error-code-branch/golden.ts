import { BaerlyError, type Db } from "@gusto/baerly-storage";
export async function main(db: Db) {
  const tickets = db.collection("tickets");
  await tickets.insert({ _id: "t-1", title: "first" });
  try {
    await tickets.insert({ _id: "t-1", title: "second" });
  } catch (error) {
    if (error instanceof BaerlyError) {
      return { code: error.code, retriable: error.retriable };
    }
    throw error;
  }
  throw new Error("second insert should have failed");
}
