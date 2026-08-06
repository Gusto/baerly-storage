import {
  type DocumentData,
  encodeJsonBytes,
  type Storage,
  versionFromContent,
} from "@baerly/protocol";

/** Seed one content side object in the layout emitted by legacy writers. */
export const seedLegacyContentForBody = async (
  storage: Storage,
  collectionPrefix: string,
  body: DocumentData,
): Promise<string> => {
  const bytes = encodeJsonBytes(body);
  const version = await versionFromContent(bytes);
  const key = `${collectionPrefix}/content/${version}.json`;
  await storage.put(key, bytes, { contentType: "application/json" });
  return key;
};
