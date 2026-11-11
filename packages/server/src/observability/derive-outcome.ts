/**
 * Canonical-line outcome derivation for HTTP requests. Shared
 * helper used by `packages/server/src/http/router.ts` (Mode B
 * standalone branch) and both host adapters
 * (`@baerly/adapter-node`'s server.ts and
 * `@baerly/adapter-cloudflare`'s worker.ts).
 *
 * Classification rules (evaluated in order):
 *
 *  0. `error.code` is `CapacityExceeded` (409) or `MaintenancePending`
 *     (503) → `"refused"`: the capacity check refused the write before
 *     any commit. Neither is a server fault nor a write conflict, so
 *     they stay out of the `"error"` and `"conflict"` rates.
 *  1. `error !== undefined && status >= 500` → `"error"`. The
 *     handler threw and the wire status surfaced as 5xx; the
 *     canonical line carries the diagnostic at error level.
 *  2. `status < 400` and `method === "GET"`     → `"read"`.
 *  3. `status < 400` and any other method        → `"committed"`.
 *  4. `status === 409`                           → `"conflict"`
 *     (writer CAS loss).
 *  5. Anything else (other 4xx/5xx)              → `"error"`.
 *
 * Pure function — no allocations beyond the returned string
 * literal, no logging, no side effects. Safe to call from any
 * scope.
 *
 * @param method - The HTTP method that produced this response.
 *                 Case-sensitive; pass `req.method` verbatim.
 * @param status - The wire status the caller will see. For thrown
 *                 errors that haven't yet mapped to a response,
 *                 pass the result of `mapError(err).status`.
 * @param error  - The error object attached to the request (if
 *                 any). Optional — pass `undefined` on the
 *                 happy path.
 */
export type Outcome = "read" | "committed" | "conflict" | "refused" | "error";

/**
 * Whether `error` is a capacity refusal (`CapacityExceeded` or
 * `MaintenancePending`): the write was refused before any commit because
 * the collection is at its host's fold ceiling. Read by the canonical
 * line's level, which logs these at `warn` even on a 503.
 */
export const isCapacityRefusal = (error: unknown): boolean => {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return code === "CapacityExceeded" || code === "MaintenancePending";
};

export const deriveOutcome = (method: string, status: number, error?: unknown): Outcome => {
  if (isCapacityRefusal(error)) {
    return "refused";
  }
  if (error !== undefined && status >= 500) {
    return "error";
  }
  if (status < 400) {
    return method === "GET" ? "read" : "committed";
  }
  if (status === 409) {
    return "conflict";
  }
  return "error";
};
