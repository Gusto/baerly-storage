/**
 * @internal — kernel primitives the CLI, adapters, bench, and tests share:
 * the monolithic snapshot codec, the log walk and tail probe, the adapter
 * verifier resolver, the config/schema helpers behind `Db`, and the
 * manifest/log read seams the HTTP handlers drive against a `Db`.
 *
 * Mirrors `_internal/testing`: intentionally NOT in `publishConfig.exports`,
 * so the published package does not surface it.
 */
export { resolveVerifier } from "../auth/internal/resolve-verifier.ts";
export { collectionsToMaps } from "../config.ts";
export {
  collectionReadContext,
  getCurrentJson,
  getLogEntry,
  probeLogChunk,
  probeLogTail,
} from "../db-read-seams.ts";
export { probeTailFrom } from "../log-tail.ts";
export { walkLogRange } from "../log-walk.ts";
export { validateOrThrow } from "../schema.ts";
export {
  type SnapshotBody,
  encodeSnapshotBody,
  loadSnapshotAsMap,
  snapshotKey,
} from "../snapshot.ts";
