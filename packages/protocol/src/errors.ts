/**
 * Discriminator for {@link BaerlyError}. Strings (not subclasses) so they
 * survive cross-realm boundaries (e.g. a Web Worker) and so callers can
 * pattern-match with grep-friendly equality.
 */
export type BaerlyErrorCode =
  /** Caller-provided config or input is invalid (bad bucket, unsupported credential type, malformed URL, bucket not version-enabled when versioning was requested). */
  | "InvalidConfig"
  /** Generic S3/HTTP transport failure (5xx, unexpected status, retries exhausted). */
  | "NetworkError"
  /** S3 returned 403. Either credentials are wrong or the bucket policy denies the operation. */
  | "AccessDenied"
  /** Server returned data that didn't parse (malformed XML, non-JSON body where JSON expected). */
  | "InvalidResponse"
  /** Internal invariant violation — should not be reachable. File a bug. */
  | "Internal"
  /**
   * Document body failed schema validation. Emitted by the table-API
   * write verbs (`Collection.insert`, `Query.update`, `Collection.replace`) when
   * the body is not valid JSON or contains an array where
   * `DocumentValue` is required; also emitted when a collection has a
   * declared `SchemaValidator` (via `Db.create({ collections })`) and
   * the bound schema rejects the doc. In the schema-rejection case the
   * error carries an `issues` array describing each failure. HTTP layer
   * maps this to 400.
   */
  | "SchemaError"
  /**
   * Write conflicted with current state: CAS retry budget exhausted,
   * duplicate caller-supplied `_id`, or an already-existing guarded
   * storage key. Check `BaerlyError.retriable` to decide whether the
   * same logical operation should be retried.
   */
  | "Conflict"
  /**
   * `Verifier` returned no identity. HTTP server maps to 401.
   * Code is reserved here so the union locks.
   */
  | "Unauthorized"
  /**
   * The addressed resource does not exist. HTTP server maps to 404.
   * Emitted by the row-by-id read / update / delete handlers in
   * `packages/server/src/http/router.ts` when the predicate
   * `{ _id }` matches zero rows. Not a protocol invariant —
   * callers may retry after creating the resource or treat as a
   * miss depending on intent. The CLI maps this to the generic
   * exit-2 "storage error" bucket, not the exit-3 "protocol
   * invariant" bucket.
   */
  | "NotFound"
  /**
   * Request body exceeded the server's size cap. HTTP server maps
   * to 413. Cap is `MAX_BODY_BYTES` (1 MiB today; exported from
   * `packages/server/src/http/router.ts`). The Node adapter
   * enforces during the `node:http` stream pump so the process
   * never materializes a multi-MiB body; Workers also rely on
   * platform-side caps (16 MB free / 100 MB paid).
   */
  | "PayloadTooLarge"
  /**
   * A predicate is structurally well-formed but contradicts itself —
   * no document can match. Emitted by `validateWire` and
   * `mergePredicateWires`. Triggers:
   *  - `{ clauses: [{op:"in", field:"priority", value:[]}] }` (empty `in` set)
   *  - an `eq` clause with a value outside the residual interval
   *    established by range clauses on the same field
   *  - merging `{op:"gt", value:10}` with `{op:"lt", value:5}` on the
   *    same field (empty interval)
   *  - merging two `in` clauses on the same field with empty intersection
   *
   * Conflicting equality across clauses (`eq:"open"` + `eq:"closed"` on
   * the same field) surfaces as `InvalidConfig` rather than this code —
   * the merger treats it as a caller-side configuration bug, not an
   * algebraic contradiction.
   *
   * The HTTP layer treats this as a 400 (caller error). The distinct
   * code lets downstream code short-circuit empty-by-construction
   * without re-running the validator or parsing messages.
   */
  | "UnsatisfiablePredicate"
  /**
   * A `useQuery` callback awaited a recorder terminal
   * (`.get`/`.first`/`.all`/`.count`). The recorder runs once per
   * render to capture the chain shape; it cannot survive an `await`
   * because the proxy doesn't proxy across microtask boundaries. The
   * recorder's terminal returns a thenable whose `.then` throws this
   * error synchronously, converting what would otherwise be a silent
   * spinner-hang into a render-time error the hook surfaces as
   * `status: "error"`. Companion `baerly/no-await-in-use-query` lint
   * flags the pattern at edit time. For compound reads, use
   * `Promise.all` (parallel) or compose two `useQuery` calls with
   * `useQuery.skip` (dependent).
   */
  | "UseQueryAwaitedRecorder"
  /**
   * A write method (`.insert`/`.update`/`.replace`/`.delete`) was
   * called on the recorder inside a `useQuery` callback. Writes
   * inside reads are a programming error; the recorder rejects them
   * synchronously from the discovery pass, before any I/O fires. Use
   * `useMutation()` instead.
   */
  | "UnexpectedWriteInQuery"
  /**
   * A `useMutation()` callback rejected with a non-`BaerlyError`
   * throwable. The hook wraps the original throw under this code so
   * the `error` slot is always a `BaerlyError`; the original value
   * is preserved on `.cause`.
   */
  | "MutationFailed";

/**
 * Codes whose default failure class is resolved by retrying with a fresh read.
 * Throw sites may override this when the same code is context-sensitive
 * (notably caller-supplied `_id` collisions, which also use `Conflict`).
 */
export const RETRIABLE_CODES: ReadonlySet<BaerlyErrorCode> = new Set<BaerlyErrorCode>([
  "NetworkError",
  "Conflict",
]);

/** True iff this error code's default failure class is retriable. */
export const isRetriableCode = (code: BaerlyErrorCode): boolean => RETRIABLE_CODES.has(code);

/**
 * The single error class thrown by baerly-storage. Discriminate by `code`, not
 * `instanceof`: the code string survives `JSON.stringify` round-trips
 * across Worker / iframe / postMessage realm boundaries, where each
 * realm has its own `BaerlyError` constructor identity. IDB-restored
 * writes can replay across realms, so `instanceof` would spuriously
 * fail on a structurally-identical error from another realm.
 *
 * @example
 * ```ts
 * try {
 *   await db.collection("tickets").insert({ title: "hi" });
 * } catch (err) {
 *   if (err instanceof BaerlyError && err.code === "Conflict") {
 *     // Check err.retriable; CAS can retry, duplicate _id cannot.
 *   }
 *   throw err;
 * }
 * ```
 */
export class BaerlyError extends Error {
  readonly code: BaerlyErrorCode;
  override readonly cause?: unknown;
  /**
   * Structured field-path issues, set only when `code === "SchemaError"`.
   * Each entry's `path` is a dotted-key list (e.g. `["assignee", "team"]`
   * or `["items", 3, "qty"]`) that targets the offending field on the
   * input document. `message` is the validator-emitted human string.
   *
   * The HTTP layer's `mapError` renders these into the 400 body via
   * the existing `HttpErrorEnvelope`; older callers that don't know
   * about `issues` see a plain message-only error and stay correct.
   */
  readonly issues?: ReadonlyArray<{
    readonly path: ReadonlyArray<string | number>;
    readonly message: string;
  }>;
  /**
   * Raw HTTP status, set only by the client-side wire decoder when
   * inflating an `HttpErrorEnvelope` into this class. Server-side
   * throws never set it (the HTTP layer's `mapError` derives the
   * outbound status from `code`). Useful for diagnostics — e.g. to
   * distinguish 404-as-"no such row" from 404-as-"route not found".
   * Discriminate by `code` for behavior; reach for `status` only when
   * you genuinely need the wire value.
   */
  readonly status?: number;
  /** Canonical corrective action; crosses the wire via `HttpErrorEnvelope.error.resolution`. */
  readonly resolution?: string;
  private readonly retriableOverride: boolean | undefined;

  /**
   * Whether this error instance is retriable. Defaults from `code`, but
   * context-sensitive throw sites can override it.
   */
  get retriable(): boolean {
    return this.retriableOverride ?? isRetriableCode(this.code);
  }

  constructor(
    code: BaerlyErrorCode,
    message: string,
    cause?: unknown,
    issues?: ReadonlyArray<{
      readonly path: ReadonlyArray<string | number>;
      readonly message: string;
    }>,
    status?: number,
    resolution?: string,
    retriableOverride?: boolean,
  ) {
    super(message);
    this.name = "BaerlyError";
    this.code = code;
    this.cause = cause;
    this.retriableOverride = retriableOverride;
    // Stryker disable next-line ConditionalExpression: field declaration creates property with undefined value; mutation to true is equivalent
    if (issues !== undefined) {
      this.issues = issues;
    }
    // Stryker disable next-line ConditionalExpression: field declaration creates property with undefined value; mutation to true is equivalent
    if (status !== undefined) {
      this.status = status;
    }
    // Stryker disable next-line ConditionalExpression: field declaration creates property with undefined value; mutation to true is equivalent
    if (resolution !== undefined) {
      this.resolution = resolution;
    }
  }
}
