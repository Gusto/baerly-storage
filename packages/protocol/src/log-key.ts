/**
 * Log-object key construction — a zero-import leaf module.
 *
 * Kept separate from `log.ts` on purpose: `log.ts` carries the heavier
 * `lsn` parsing runtime (`lsnParts`, the LSN regex, `str2uintDesc`).
 * Routing `gc` / `writer` / `log-walk` through a key helper that lived in
 * `log.ts` dragged that whole module into the `maintenance.js` bundle
 * closure (+3.8 KB raw). This module imports nothing, so consumers that
 * only need the key shape pull only the key shape.
 */

/** S3 path segment for log entries, under the manifest prefix. */
export const LOG_KEY_PREFIX = "log";

/**
 * The single constructor for a log-object key:
 * `<manifestPrefix>/log/<seq>.json`. `manifestPrefix` is the
 * `<…>/manifests/<collection>` segment — this helper adds `/log/`.
 * `<seq>` is unpadded decimal, so lexicographic LIST order is not numeric
 * order (`log/10.json` precedes `log/2.json`). The descending base-32 LSN
 * encoding applies to LSN values and the LSN half of `/v1/since` cursors,
 * not these keys.
 * Route all callers here so the key shape lives in one place.
 */
export const logObjectKey = (manifestPrefix: string, seq: number): string =>
  `${manifestPrefix}/${LOG_KEY_PREFIX}/${seq}.json`;
