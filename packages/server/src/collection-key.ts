/**
 * Splits a `current.json` key (`<collectionPrefix>/current.json`) into the
 * collection's key prefix and its trailing name segment. `compact()`,
 * `runGc()`, `retireLogRange()` and the maintenance runner all take the
 * key and derive these the same way.
 */
export const collectionFromCurrentJsonKey = (
  currentJsonKey: string,
): { prefix: string; name: string } => {
  const prefix = currentJsonKey.slice(0, currentJsonKey.lastIndexOf("/"));
  return { prefix, name: prefix.slice(prefix.lastIndexOf("/") + 1) };
};
