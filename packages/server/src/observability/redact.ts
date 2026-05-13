/**
 * Error redaction for the canonical log line.
 *
 * `serializeError` produces the `{ code, message, stack? }` shape
 * the canonical line carries under its `error` key. Two rules:
 *
 * 1. **`BaerlyError`** — preserve its `code` discriminant verbatim.
 *    The error hierarchy lives in `packages/protocol/src/errors.ts`
 *    and consumers branch on the string code, not `instanceof`.
 *
 * 2. **Any other error or non-error value** — collapse to
 *    `{ code: "Internal", message: <stringified> }`. The Phase-9
 *    operator-facing contract is that anything we didn't classify
 *    as a `BaerlyError` is a kernel-internal bug, hence the
 *    catch-all `Internal` code.
 *
 * Stacks are opt-in. Two independent gates:
 *
 * - `includeStack` parameter (caller-driven; the logger module
 *   passes `true` only for the `debug` level).
 * - `BAERLY_LOG_STACKS=1` env var (operator-driven; one process-
 *   wide override). Either gate alone is enough to suppress; both
 *   must permit for the stack to appear.
 *
 * The two-gate design lets operators turn stacks on globally
 * during an incident without having to redeploy with a different
 * log level, while still defaulting off in steady state.
 */

import { BaerlyError } from "@baerly/protocol";

/**
 * Shape carried by the canonical line under its `error` key.
 *
 * `code` is one of {@link BaerlyErrorCode} for known `BaerlyError`s,
 * or the literal `"Internal"` for anything else. The string-typing
 * keeps the consumer-side handling grep-friendly.
 */
export interface SerializedError {
  readonly code: string;
  readonly message: string;
  readonly stack?: string;
}

/**
 * Convert an unknown thrown value into a {@link SerializedError}.
 *
 * @param err The thrown value (anything `try { ... } catch (e)` can yield).
 * @param includeStack If `true` AND `BAERLY_LOG_STACKS=1`, include
 *   the stack trace. Defaults to `false`.
 */
export const serializeError = (err: unknown, includeStack = false): SerializedError => {
  const wantsStack = includeStack && stacksEnabled();

  if (err instanceof BaerlyError) {
    const base: SerializedError = { code: err.code, message: err.message };
    return wantsStack && err.stack !== undefined ? { ...base, stack: err.stack } : base;
  }

  if (err instanceof Error) {
    const base: SerializedError = { code: "Internal", message: err.message };
    return wantsStack && err.stack !== undefined ? { ...base, stack: err.stack } : base;
  }

  // Non-Error throws: strings, numbers, objects, null. Use a
  // structured fallback for objects (JSON.stringify) and a plain
  // String() conversion otherwise.
  if (typeof err === "object" && err !== null) {
    try {
      return { code: "Internal", message: JSON.stringify(err) };
    } catch {
      return { code: "Internal", message: "[unserializable object]" };
    }
  }
  return { code: "Internal", message: String(err) };
};

/**
 * Read the `BAERLY_LOG_STACKS` env var. Wrapped to dodge the
 * Workers Runtime's `process` shim — `globalThis.process?.env` is
 * the portable form. Returns `true` iff the var is the literal
 * string `"1"`.
 */
const stacksEnabled = (): boolean => {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  return env?.["BAERLY_LOG_STACKS"] === "1";
};
