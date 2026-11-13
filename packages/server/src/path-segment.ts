import { BaerlyError } from "@baerly/protocol";
import { assertNameNotReserved } from "./names.ts";

/**
 * Per-segment byte ceiling. S3 and R2 cap a full object key at 1024
 * UTF-8 bytes; a key is several segments, so this 256 leaves real prefix
 * headroom. The assembled multi-segment key sum is bounded separately on
 * the write path, not here. This is an intentional server-local *policy*
 * value (not the protocol-level S3/R2 fact `MAX_KEY_BYTES = 1024` in
 * `@baerly/protocol`'s `constants.ts`); it lives here, co-located with the
 * one rule that uses it, to keep `protocol/constants.ts` out of the
 * validator's bundle closure.
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
 * `"."`|`".."` / C0-C1 control / leading `"_"` (ADR-003) / `> MAX_SEGMENT_BYTES`,
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
  // Leading `_` is the ADR-003 reserved namespace.
  assertNameNotReserved(value, where);
};

/**
 * Resolution for a non-NFC app, tenant, or collection name. Data an
 * earlier release stored under one stays readable through the operator
 * CLI, and is migrated by export and restore under a new name.
 */
const NAME_NFC_RESOLUTION =
  'Pass name.normalize("NFC") for a new app, tenant, or collection name. The SDK refuses non-NFC names. Export legacy data with `baerly admin dump` and restore it with `baerly admin restore` under an NFC name that is not canonically equivalent to the original. The normalized original name is not a safe target, because R2 stores canonically-equivalent keys as one object.';

/**
 * Require `value` to be in Unicode Normalization Form C
 * (`value === value.normalize("NFC")`). R2 stores canonically-equivalent
 * keys (NFC `é` and NFD `e` + U+0301) as one object, so two segments that
 * differ only by normalization would address the same objects there. NFC
 * gives each equivalence class one spelling. Case and compatibility
 * variants (`A` / `a`, `ﬁ` / `fi`) are distinct NFC strings and stay
 * distinct. Shared by the `_id` write guard and {@link assertNameSegment}.
 *
 * @param resolution  the `BaerlyError.resolution` for this segment's role.
 * @throws BaerlyError code="InvalidConfig" — `value` is not NFC.
 */
export const assertNfcSegment = (
  value: string,
  role: string,
  verb: string,
  resolution: string,
): void => {
  if (value !== value.normalize("NFC")) {
    const where = verb === "" ? role : `${verb}: ${role}`;
    throw new BaerlyError(
      "InvalidConfig",
      `${where} must be in Unicode Normalization Form C: ${JSON.stringify(value)}`,
      { resolution },
    );
  }
};

/**
 * Guard an app, tenant, or collection name that the SDK, the HTTP
 * router, or a writing CLI verb addresses: {@link assertPathSegment},
 * then {@link assertNfcSegment}. Names are never normalized on the
 * caller's behalf, so two canonically-equivalent names are never merged
 * into one. The read-only CLI verbs (`inspect`, `export`, `cost`,
 * `admin dump`, `admin fsck`, `admin usage`) apply only
 * {@link assertPathSegment}, which keeps a legacy non-NFC name readable
 * and exportable.
 *
 * @throws BaerlyError code="InvalidConfig" — the name breaks the
 *   key-segment rule or is not NFC.
 */
export const assertNameSegment = (value: string, role: string, verb = ""): void => {
  assertPathSegment(value, role, verb);
  assertNfcSegment(value, role, verb, NAME_NFC_RESOLUTION);
};
