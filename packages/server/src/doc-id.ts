import { BaerlyError, CODE_RESOLUTIONS } from "@baerly/protocol";
import { assertPathSegment } from "./path-segment.ts";

/**
 * Guard a caller-supplied `_id` before it becomes a written key segment
 * (index keys, log `doc_id`) or filesystem path (`LocalFsStorage`). The
 * `_id` analogue of `assertKeySegment` (`db.ts`). Routes through the
 * single shared {@link assertPathSegment} rule (empty / `"/"` /
 * `"."`|`".."` / C0-C1 control chars / leading `"_"` (ADR-003) / overlong,
 * all as `BaerlyError{code:"InvalidConfig"}`).
 */
export const assertDocId = (id: string): void => {
  assertPathSegment(id, "_id");
};

/**
 * The `AlreadyExists` an insert throws when a live row holds `docId`.
 * Shared by `runInsert`'s check read (`./query.ts`) and the writer's
 * insert guard (`./writer.ts`), so a caller sees one error whichever
 * side caught the collision. Not retriable; `err._id` is `docId`.
 */
export const insertAlreadyExists = (collection: string, docId: string): BaerlyError =>
  new BaerlyError(
    "AlreadyExists",
    `insert: _id ${JSON.stringify(docId)} already exists in collection ${JSON.stringify(collection)}`,
    undefined,
    undefined,
    undefined,
    CODE_RESOLUTIONS.AlreadyExists,
    docId,
  );
