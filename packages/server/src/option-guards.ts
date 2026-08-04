/**
 * Shared pre-I/O validation for the internal maintenance option seams
 * (`InternalCompactOptions`, `InternalRunGcOptions`).
 *
 * Those seams are unvalidated by construction — reached by JS callers,
 * in-repo casts, and the `_internal/testing` subpath — yet their values
 * feed seq arithmetic and range bounds. A non-finite value must fail
 * before the first storage operation, so a rejected run costs nothing
 * durable. `compactor.ts` explains the specific NaN corruption at stake.
 *
 * Zero-import leaf beyond `BaerlyError`: both maintenance entry points
 * already carry that import, so consolidating here removes duplication
 * without widening either closure.
 */

import { BaerlyError } from "@baerly/protocol";

/**
 * Throw `InvalidConfig` unless `value` is an integer at or above `min`.
 * `min` is `0` for a seq-shaped or count-shaped option (zero is a
 * meaningful "do nothing" bound) and `1` for one that must make at least
 * one unit of progress to be well-defined.
 *
 * Callers own the `undefined ⇒ default` decision before calling; this
 * guard rejects rather than defaults, so passing an absent option is a
 * caller bug, not a silently-tolerated input.
 */
export const requireIntegerOption = (
  fnName: string,
  collectionName: string,
  optionName: string,
  value: number,
  min: 0 | 1,
): void => {
  if (!Number.isInteger(value) || value < min) {
    throw new BaerlyError(
      "InvalidConfig",
      `${fnName}(${collectionName}): ${optionName} must be a ${
        min === 0 ? "non-negative" : "positive"
      } integer, got ${String(value)}`,
    );
  }
};
