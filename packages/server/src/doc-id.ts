import { assertPathSegment } from "./path-segment.ts";

/**
 * Guard a caller-supplied `_id` before it becomes a written key segment
 * (index keys, log `doc_id`) or filesystem path (`LocalFsStorage`). The
 * `_id` analogue of `assertKeySegment` (`db.ts`). Routes through the
 * single shared {@link assertPathSegment} rule (empty / `"/"` /
 * `"."`|`".."` / C0-C1 control chars / leading `"_"` (ADR-007) / overlong,
 * all as `BaerlyError{code:"InvalidConfig"}`).
 */
export const assertDocId = (id: string): void => {
  assertPathSegment(id, "_id");
};
