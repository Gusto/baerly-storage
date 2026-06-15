import { BaerlyError } from "@baerly/protocol";
import { assertNameNotReserved } from "./names.ts";

// Per-segment ceiling: S3/R2 cap a full key at 1024 UTF-8 bytes and
// `_id` is one segment of a longer key, so this leaves prefix headroom.
const MAX_DOC_ID_BYTES = 1024;
const utf8 = new TextEncoder();
// C0 (U+0000-U+001F) + DEL/C1 (U+007F-U+009F).
// eslint-disable-next-line no-control-regex -- intentional control-char class
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * Guard a caller-supplied `_id` before it becomes a written key segment
 * (index keys, log `doc_id`) or filesystem path (`LocalFsStorage`). The
 * `_id` analogue of `assertKeySegment` (`db.ts`). Rejects empty / `"/"` /
 * `"."`|`".."` / C0-C1 control chars / leading `"_"` (ADR-007) / overlong,
 * all as `BaerlyError{code:"InvalidConfig"}`.
 */
export const assertDocId = (id: string): void => {
  if (id.length === 0) {
    throw new BaerlyError("InvalidConfig", "_id must be a non-empty string");
  }
  if (id.includes("/")) {
    throw new BaerlyError("InvalidConfig", `_id may not contain "/": ${JSON.stringify(id)}`);
  }
  if (id === "." || id === "..") {
    throw new BaerlyError("InvalidConfig", `_id may not be "." or "..": ${JSON.stringify(id)}`);
  }
  if (CONTROL_CHARS.test(id)) {
    throw new BaerlyError("InvalidConfig", `_id may not contain control characters`);
  }
  if (utf8.encode(id).length > MAX_DOC_ID_BYTES) {
    throw new BaerlyError("InvalidConfig", `_id is too long (> ${MAX_DOC_ID_BYTES} bytes)`);
  }
  // Leading `"_"` is the ADR-007 reserved namespace — shared with the
  // structural segments via assertNameNotReserved.
  assertNameNotReserved(id, "_id");
};
