import { MAX_DOCUMENT_BYTES } from "./constants.ts";
import { BaerlyError } from "./errors.ts";

// Kept apart from `document-input.ts`: the HTTP client bundles that module
// for its pre-send value check, and the size cap is the server's to enforce.
const DOCUMENT_SIZE_RESOLUTION = `Keep each document at or under ${MAX_DOCUMENT_BYTES} bytes (1 MiB) of JSON: move large or growing data (attachments, long histories, arrays that keep growing) into rows of their own, or store blobs outside the database and keep a reference.`;

/**
 * UTF-8 byte length of `json` when it is over `limit`, else `undefined`.
 * Skips the encode when the string is short enough to decide it: a UTF-16
 * code unit encodes to at most 3 bytes.
 */
const jsonByteLengthAbove = (json: string, limit: number): number | undefined => {
  if (json.length * 3 <= limit) {
    return undefined;
  }
  const bytes = new TextEncoder().encode(json).byteLength;
  return bytes > limit ? bytes : undefined;
};

/**
 * Refuse a post-image larger than {@link MAX_DOCUMENT_BYTES} once encoded
 * as stored (`encodeJsonBytes`, which sorts nothing, so key order does not
 * change the size). Call it on the whole document a write would commit,
 * not on an update patch: a small patch can still grow a row past the cap.
 * A row already stored larger is not checked here; only a write producing
 * an over-cap post-image is refused.
 *
 * I/O-free. The value must already be in the JSON document domain (see
 * `assertDocumentValues`); a value `JSON.stringify` cannot encode
 * throws its own error.
 *
 * @param verb  the calling verb, used as the message prefix.
 * @throws BaerlyError code="InvalidConfig" — the encoded post-image is over
 *   the cap. The message states its size and the limit.
 */
export const assertDocumentSize = (value: unknown, verb: string): void => {
  const bytes = jsonByteLengthAbove(JSON.stringify(value), MAX_DOCUMENT_BYTES);
  if (bytes !== undefined) {
    throw new BaerlyError(
      "InvalidConfig",
      `${verb}: the document encodes to ${bytes} bytes of JSON, over the ${MAX_DOCUMENT_BYTES}-byte (1 MiB) document limit`,
      { resolution: DOCUMENT_SIZE_RESOLUTION },
    );
  }
};
