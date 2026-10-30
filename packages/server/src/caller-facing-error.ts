import type { BaerlyError } from "@baerly/protocol";

/**
 * Errors whose message is written for the caller of the public API rather
 * than for the operator. The HTTP layer exposes a contextual code's message
 * (`InvalidConfig`) only for errors in this set; any other `InvalidConfig`,
 * such as a storage or adapter configuration fault that can carry bucket
 * layout, stays scrubbed.
 */
const CALLER_FACING_ERRORS = new WeakSet<BaerlyError>();

/** Mark `err` as caller input at the point it is thrown, and return it. */
export const markCallerFacing = <E extends BaerlyError>(err: E): E => {
  CALLER_FACING_ERRORS.add(err);
  return err;
};

/** True when `err` was marked with {@link markCallerFacing}. */
export const isCallerFacing = (err: BaerlyError): boolean => CALLER_FACING_ERRORS.has(err);
