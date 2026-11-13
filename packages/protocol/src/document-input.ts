import { BaerlyError } from "./errors.ts";

const INSERT_ID_RESOLUTION =
  "Pass _id as a non-empty string (for example String(value)), or omit it to have one generated.";

/**
 * Reject a present, non-string `_id` on an insert. `undefined` is absent and
 * `""` is a string, so both still get a generated id; `null`, numbers
 * (`-0` and `NaN` included), booleans, objects and arrays throw. Checks the
 * caller's own value, before anything replaces it with a generated id.
 * Shared by the server's insert and the HTTP client's, so the two agree on
 * which ids are generated.
 *
 * @throws BaerlyError code="InvalidConfig" — `id` is present and not a string.
 */
export const assertInsertIdType = (id: unknown): void => {
  if (id !== undefined && typeof id !== "string") {
    throw new BaerlyError(
      "InvalidConfig",
      `insert: _id must be a string, got ${id === null ? "null" : typeof id}`,
      { resolution: INSERT_ID_RESOLUTION },
    );
  }
};
