import { BaerlyError } from "@baerly/protocol";
import { assertNameNotReserved } from "./names.ts";

/**
 * Per-segment byte ceiling. S3 and R2 cap a full object key at 1024
 * UTF-8 bytes; a key is several segments, so this 256 leaves real prefix
 * headroom. The assembled multi-segment key sum is bounded separately on
 * the write path, not here.
 */
export const MAX_SEGMENT_BYTES = 256;
const utf8 = new TextEncoder();
// C0 (U+0000-U+001F) + DEL/C1 (U+007F-U+009F).
// eslint-disable-next-line no-control-regex -- intentional control-char class
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * The single validation rule for every caller-controlled key segment
 * (`_id`, `collection`, `app`, `tenant`) before it becomes a written
 * key segment or `LocalFsStorage` path. Rejects empty / `"/"` /
 * `"."`|`".."` / C0-C1 control / leading `"_"` (ADR-007) / `> MAX_SEGMENT_BYTES`,
 * all as `BaerlyError{code:"InvalidConfig"}`.
 *
 * @param role  human label for the segment ("_id" | "collection" | "app" | "tenant").
 * @param verb  optional calling-context label for the message.
 */
export const assertPathSegment = (value: string, role: string, verb = ""): void => {
  const where = verb === "" ? role : `${verb}: ${role}`;
  if (value.length === 0) {
    throw new BaerlyError("InvalidConfig", `${where} must be a non-empty string`);
  }
  if (value.includes("/")) {
    throw new BaerlyError(
      "InvalidConfig",
      `${where} may not contain "/": ${JSON.stringify(value)}`,
    );
  }
  if (value === "." || value === "..") {
    throw new BaerlyError(
      "InvalidConfig",
      `${where} may not be "." or "..": ${JSON.stringify(value)}`,
    );
  }
  if (CONTROL_CHARS.test(value)) {
    throw new BaerlyError("InvalidConfig", `${where} may not contain control characters`);
  }
  if (utf8.encode(value).length > MAX_SEGMENT_BYTES) {
    throw new BaerlyError("InvalidConfig", `${where} is too long (> ${MAX_SEGMENT_BYTES} bytes)`);
  }
  // Leading `_` is the ADR-007 reserved namespace.
  assertNameNotReserved(value, where);
};
