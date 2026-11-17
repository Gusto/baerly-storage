/**
 * Message for a durable object whose `schema_version` this build does not
 * read. A larger integer was written by a newer release; anything else is
 * not an object this build wrote. States both versions and an app remedy;
 * never names host settings or suggests deleting data.
 */
export const unsupportedSchemaVersionMessage = (
  where: string,
  found: unknown,
  supported: number,
): string =>
  typeof found === "number" && Number.isInteger(found) && found > supported
    ? `${where}: schema_version ${found} was written by a newer baerly-storage release; this build supports schema_version ${supported}. Run that release or newer.`
    : `${where}: unsupported schema_version ${String(found)}; this build supports schema_version ${supported}. This object was not written by this build.`;
