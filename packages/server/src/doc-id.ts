import { BaerlyError, CODE_RESOLUTIONS, type DocumentData, jsonValueEqual } from "@baerly/protocol";
import { getCurrentContext } from "./observability/context.ts";
import { assertPathSegment } from "./path-segment.ts";

/**
 * Resolution for a non-NFC `_id`. A row stored under one by an earlier
 * release stays readable and deletable, so it is migrated by copy.
 */
const DOC_ID_NFC_RESOLUTION =
  'Pass id.normalize("NFC") for a new _id. To migrate a stored non-NFC row, insert a copy under a fresh NFC id that is not canonically equivalent to the original (for example, omit _id for a UUID), then delete the original. On R2, copying to the normalized original id before deleting it would remove the copy\'s index markers.';

/**
 * Guard an `_id` a write is about to store a row under: an insert, a
 * replace, an update, or any `I` / `U` commit. The `_id` analogue of
 * `assertKeySegment` (`db.ts`).
 *
 * Applies {@link assertStoredDocId}, then requires the id to be in Unicode
 * Normalization Form C (`id === id.normalize("NFC")`). Index marker keys
 * embed the raw `_id`, and R2 stores canonically-equivalent keys (NFC `é`
 * and NFD `e` + U+0301) as one object, so two rows whose ids differ only
 * by normalization would share a marker. NFC gives each equivalence class
 * one spelling. Case and compatibility variants (`A` / `a`, `ﬁ` / `fi`)
 * are distinct NFC strings and stay distinct ids.
 *
 * @throws BaerlyError code="InvalidConfig" — the id breaks the key-segment
 *   rule or is not NFC.
 */
export const assertDocId = (id: string): void => {
  assertStoredDocId(id);
  if (id !== id.normalize("NFC")) {
    throw new BaerlyError(
      "InvalidConfig",
      `_id must be in Unicode Normalization Form C: ${JSON.stringify(id)}`,
      { resolution: DOC_ID_NFC_RESOLUTION },
    );
  }
};

/**
 * Guard an `_id` that names an existing row: the `doc_id` of a delete.
 * Only the key-segment rule applies (the single shared
 * {@link assertPathSegment}: empty / `"/"` / `"."`|`".."` / C0-C1 control
 * chars / leading `"_"` (ADR-003) / overlong, all as
 * `BaerlyError{code:"InvalidConfig"}`), so a row stored under a non-NFC id
 * before {@link assertDocId} required NFC can still be deleted.
 */
export const assertStoredDocId = (id: string): void => {
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
    { resolution: CODE_RESOLUTIONS.AlreadyExists, _id: docId },
  );

/**
 * `true` when the stored live row `stored` is the row an insert of `body`
 * would have written: structurally equal after the JSON round-trip the
 * write path's encoder applies (key order ignored, `undefined` properties
 * dropped). `body` is the insert's post-image `{ ...doc, _id }`; the
 * stored row carries no other server-stamped field (log metadata lives on
 * the `LogEntry`, not in `after`).
 *
 * Shared by `runInsert`'s check read and the writer's insert guard, so an
 * SDK-minted insert replays on the same rule whichever side found the row.
 */
export const insertReplaysRow = (body: DocumentData, stored: DocumentData | undefined): boolean =>
  stored !== undefined && jsonValueEqual(JSON.parse(JSON.stringify(body)), stored);

/**
 * Count an SDK-minted insert answered as a replay of its stored row on
 * `db.write.insert_replayed_total` (labelled by `collection`). A replay
 * commits nothing and records no write metric, so without this counter it
 * is invisible on the canonical line. Shared by `runInsert`'s check read
 * and the writer's insert guard, the two places a replay is decided.
 */
export const recordInsertReplay = (collection: string): void => {
  getCurrentContext()?.recorder.counter("db.write.insert_replayed_total", 1, { collection });
};
