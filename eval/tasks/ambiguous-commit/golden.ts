import { BaerlyError, type Collection } from "@gusto/baerly-storage";
export async function insertOnce(tickets: Collection, doc: { _id: string }) {
  try {
    const { _id } = await tickets.insert(doc);
    return _id;
  } catch (error) {
    if (!(error instanceof BaerlyError) || error.code !== "AmbiguousCommit") {
      throw error;
    }
    if (await tickets.get(doc._id)) {
      return doc._id;
    }
    const { _id } = await tickets.insert(doc);
    return _id;
  }
}
export async function main() {
  return undefined;
}
