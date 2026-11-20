/**
 * Whether `found` is an integer version above `supported`, i.e. an
 * object a newer release wrote. The one predicate behind every
 * "newer" decision, so a reader's message and its extra hints agree.
 */
export const isNewerSchemaVersion = (found: unknown, supported: number): found is number =>
  typeof found === "number" && Number.isInteger(found) && found > supported;

/** Longest string echoed into a message before it is cut short. */
const MAX_ECHOED_STRING_LENGTH = 64;

/**
 * A bounded, single-line rendering of a stored `schema_version` for an
 * error message. `found` is raw parsed JSON, so it may be arbitrarily deep
 * or large: arrays and objects are named by type and never walked or
 * stringified (`String()` on a deeply nested array overflows the stack),
 * and strings are truncated with their length reported. Never throws.
 */
const describeFound = (found: unknown): string => {
  if (typeof found === "string") {
    const shown = JSON.stringify(found.slice(0, MAX_ECHOED_STRING_LENGTH));
    return found.length > MAX_ECHOED_STRING_LENGTH
      ? `${shown.slice(0, -1)}…" (${String(found.length)} characters)`
      : shown;
  }
  if (typeof found === "number" || typeof found === "boolean") {
    return String(found);
  }
  if (found === null) {
    return "null";
  }
  if (found === undefined) {
    return "undefined";
  }
  if (Array.isArray(found)) {
    return "(an array)";
  }
  if (typeof found === "object") {
    return "(an object)";
  }
  return `(a ${typeof found})`;
};

/**
 * Message for a durable object whose `schema_version` this build does not
 * read. A larger integer was written by a newer release; anything else is
 * not an object this build wrote. States both versions and an app remedy;
 * never names host settings or suggests deleting data. A non-number
 * `found` is described by {@link describeFound}, so a hostile stored value
 * cannot crash the reader or inflate the message.
 */
export const unsupportedSchemaVersionMessage = (
  where: string,
  found: unknown,
  supported: number,
): string =>
  isNewerSchemaVersion(found, supported)
    ? `${where}: schema_version ${found} was written by a newer baerly-storage release; this build supports schema_version ${supported}. Run that release or newer.`
    : `${where}: unsupported schema_version ${describeFound(found)}; this build supports schema_version ${supported}. This object was not written by this build; restore it from a backup made by this release, or point the app at the right data.`;
