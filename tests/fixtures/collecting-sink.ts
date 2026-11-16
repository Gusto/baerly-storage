/**
 * In-memory LogTape sink for observability assertions. LogTape ships no
 * built-in memory sink; this builds one on the `Sink` type
 * (`(record) => void`). Pass `sink` to `configureObservability` and
 * read `records` back.
 */

import type { LogRecord, Sink } from "@logtape/logtape";

/** A sink that appends every record it receives to `records`. */
export const collectingSink = (): { records: LogRecord[]; sink: Sink } => {
  const records: LogRecord[] = [];
  const sink: Sink = (record) => records.push(record);
  return { records, sink };
};

/** The `canonical` line the request pipeline emitted for `baerly.<unit>`, if any. */
export const findCanonical = (records: readonly LogRecord[], unit: string): LogRecord | undefined =>
  records.find(
    (r) => r.message.join("") === "canonical" && r.category.join(".") === `baerly.${unit}`,
  );
