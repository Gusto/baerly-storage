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
   * Another write won a race this call needed to win, and the losing commit
   * did not land. Re-read, then retry; `retriable` is `true`. Each
   * `Collection` / `Query` verb re-reads on every call, so re-issuing the same
   * call is the retry. The writer makes one commit attempt and resolves a
   * log-create race inside it, so this surfaces from a write only for a
   * rejected precondition the writer does not resolve. Maintenance passes
   * (`compact`, `runGc`, log retirement) raise it when a concurrent pass or
   * writer moved `current.json` first; the next pass retries. HTTP maps this
   * code to 409 with a generic message.
   *
   * `Storage` implementations throw this code for every rejected
   * precondition: a stale `ifMatch`, an `ifMatch` against a missing key, or
   * an `ifNoneMatch: "*"` create over an existing key. For a create-only put
   * that followed an attempt of unknown outcome, the occupant may be this
   * call's own earlier write. Callers that care read the key back.
   */
  | "WriteConflict"
  /**
   * The thing being created already exists, so the same request can never
   * succeed; `retriable` is `false`. `Collection.insert` raises it when a
   * live row already holds the `_id`, including one a concurrent insert
   * committed first: of concurrent inserts of one `_id`, at most one
   * commits and the others raise this. Insert under a different `_id`,
   * omit `_id` to mint one, or change the stored row with `update` /
   * `replace` — unless this follows a same-`_id` retry after
   * `AmbiguousCommit`, where the stored row may be the first attempt:
   * re-read it instead of inserting under a new `_id`.
   * `baerly admin restore` raises it when the target collection already
   * exists and `--force` was not passed. HTTP maps this code to 409 and
   * keeps the message, which names the id and collection.
   */
  | "AlreadyExists"
  /**
   * A write's commit outcome cannot be resolved: one or more committing
   * `log/<seq>` creates may already be durable, but the writer cannot adopt or
   * report a confirmed commit. This includes an unresolved create acknowledgement
   * after the occupant readback, and a create that landed below the
   * certified delete floor (`seq < min(log_delete_floor, log_seq_start)`).
   *
   * `BaerlyError._id` names the affected row, including an auto-ID insert's
   * minted id. Re-read that row and compare it with the intended state before
   * deciding what to do. A matching row helps reconcile the outcome; absence
   * does not prove that a create failed, since a send may still complete or its
   * effect may have been superseded. Retrying is an explicit at-least-once
   * choice and may repeat logical work. Retry an insert with the same `_id`:
   * a second create then targets the same row instead of minting a second
   * document, and commits only if no live row holds that `_id`. An
   * `AlreadyExists` on that retry means a row with that `_id` is committed:
   * re-read it and compare with the intended state rather than inserting
   * under a new `_id`. `retriable` is `false` so generic retry wrappers do
   * not repeat the operation silently. HTTP maps this code to 409.
   */
  | "AmbiguousCommit"
  /**
   * The collection is at the fold ceiling of the host serving this request,
   * so this write was refused and nothing was committed; `retriable` is
   * `false`. The refusal is decided per request from the collection's
   * current state and clears by itself once that state changes.
   *
   * Two cases. Near the ceiling, only growth is refused (an insert, or an
   * update that makes a row larger): deletes and same-size or shrinking
   * updates still commit, and once the in-band fold drains them, growth is
   * accepted again. When the stored snapshot is already past the ceiling
   * (for example a collection folded on a larger host and now served by a
   * smaller one), or a pending insert cannot fold onto an `E`-row
   * snapshot, no fold can make progress on this host, so every write is
   * refused until the collection moves to a larger host or is exported
   * with `baerly admin dump`. Moving hosts is a deployment decision, not
   * an app setting. Reads stay served. HTTP maps this code to 409 and
   * keeps the message, which names the collection and the case.
   */
  | "CapacityExceeded"
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
 * Runtime enumeration of every {@link BaerlyErrorCode}. The spec
 * generator and the drift gate iterate this to assert the IR lists
 * each code; the type guard in `spec/ir-schema.test.ts` fails tsgo if
 * this tuple and the union diverge. Keep order stable for deterministic
 * artifact diffs. This is the canonical code list — do not re-list
 * codes elsewhere (see RETRIABLE_CODES, the sibling retriable subset).
 */
export const ERROR_CODES = [
  "InvalidConfig",
  "NetworkError",
  "AccessDenied",
  "InvalidResponse",
  "Internal",
  "SchemaError",
  "WriteConflict",
  "AlreadyExists",
  "AmbiguousCommit",
  "CapacityExceeded",
  "Unauthorized",
  "NotFound",
  "PayloadTooLarge",
  "UnsatisfiablePredicate",
  "UseQueryAwaitedRecorder",
  "UnexpectedWriteInQuery",
  "MutationFailed",
] as const satisfies readonly BaerlyErrorCode[];

// Exhaustiveness guard: every union member must appear in ERROR_CODES.
// If a code is added to BaerlyErrorCode without a tuple entry, this
// errors at tsgo time (the union is not assignable to the tuple's union).
type _ErrorCodesExhaustive = [BaerlyErrorCode] extends [(typeof ERROR_CODES)[number]]
  ? true
  : ["missing code in ERROR_CODES", Exclude<BaerlyErrorCode, (typeof ERROR_CODES)[number]>];
// eslint-disable-next-line no-underscore-dangle
const _errorCodesExhaustive: _ErrorCodesExhaustive = true;
void _errorCodesExhaustive;

/**
 * Codes whose failure can clear on retry. `BaerlyError.retriable` is
 * exactly membership in this set; there are no per-instance overrides.
 */
export const RETRIABLE_CODES: ReadonlySet<BaerlyErrorCode> = new Set<BaerlyErrorCode>([
  "NetworkError",
  "WriteConflict",
]);

/**
 * True iff `value` is a code this build knows. Wire decoders use it to
 * catch a code minted by a newer server before it reaches `code`, where
 * an unknown string would defeat both exhaustive switches and
 * {@link isRetriableCode}.
 */
export const isBaerlyErrorCode = (value: unknown): value is BaerlyErrorCode =>
  typeof value === "string" && (ERROR_CODES as readonly string[]).includes(value);

/**
 * True iff `err` is a `WriteConflict`: a lost conditional write or CAS
 * race. The one predicate every kernel catch site uses, so the code's
 * meaning is tested in one place. Matches on `name` and `code` rather
 * than `instanceof`, so an error from a second loaded copy of this module
 * or another realm still classifies.
 */
export const isWriteConflict = (
  err: unknown,
): err is BaerlyError & { readonly code: "WriteConflict" } =>
  typeof err === "object" &&
  err !== null &&
  (err as { readonly name?: unknown }).name === "BaerlyError" &&
  (err as { readonly code?: unknown }).code === "WriteConflict";

/** True iff this error code is retriable (membership in {@link RETRIABLE_CODES}). */
export const isRetriableCode = (code: BaerlyErrorCode): boolean => RETRIABLE_CODES.has(code);

/**
 * Codes raised only inside the client-side React runtime
 * (`useQuery` / `useMutation`); they never travel the HTTP wire, so the
 * machine-contract IR reports `httpStatus: null` for them — distinct
 * from a real `500` (a server-side transport/internal failure the HTTP
 * layer maps to a status). Sibling of {@link RETRIABLE_CODES}; add a
 * code here when a new client-only failure mode joins the union.
 */
export const CLIENT_RUNTIME_CODES: ReadonlySet<BaerlyErrorCode> = new Set<BaerlyErrorCode>([
  "UseQueryAwaitedRecorder",
  "UnexpectedWriteInQuery",
  "MutationFailed",
]);

/**
 * Optional fields for {@link BaerlyError}, the third constructor argument.
 * Each field lands on the same-named property of the error; an omitted
 * field leaves that property `undefined`.
 */
export interface BaerlyErrorOptions {
  /**
   * The underlying throwable, or a structured detail object. Kept on
   * `error.cause`. A `Storage` adapter reports `cause.notApplied` /
   * `cause.throttled` this way; see the `Storage.put` contract.
   */
  readonly cause?: unknown;
  /** Field-path issues; set only with `code: "SchemaError"`. Lands on {@link BaerlyError.issues}. */
  readonly issues?: ReadonlyArray<{
    readonly path: ReadonlyArray<string | number>;
    readonly message: string;
  }>;
  /** Raw HTTP status; set only by the client-side wire decoder. Lands on {@link BaerlyError.status}. */
  readonly status?: number;
  /** Canonical corrective action. Lands on {@link BaerlyError.resolution}. */
  readonly resolution?: string;
  /** The affected row's `_id`; set only with `code: "AmbiguousCommit"`. Lands on {@link BaerlyError._id}. */
  readonly _id?: string;
  /**
   * Never set. This object is not an `Error`: `Error` requires `message`, so
   * this field makes `new BaerlyError(code, msg, err)` fail to compile. To
   * chain an error, pass `{ cause: err }`.
   */
  readonly message?: never;
}

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
 *   await db.collection("tickets").insert({ _id: "t-1", title: "hi" });
 * } catch (err) {
 *   if (!(err instanceof BaerlyError)) throw err;
 *   if (err.code === "AlreadyExists") {
 *     // t-1 is taken; retrying cannot succeed.
 *   } else if (err.code === "AmbiguousCommit") {
 *     // May have landed: re-read err._id before deciding.
 *   } else if (err.retriable) {
 *     // WriteConflict or NetworkError: retry with bounded backoff.
 *   } else {
 *     throw err;
 *   }
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
   * The `_id` of the row whose commit outcome is unknown, set only when
   * `code === "AmbiguousCommit"`. For an auto-ID insert it is the minted
   * id, so the caller can re-read the row and retry with the same `_id`
   * rather than mint a second document. A missing row does not prove the
   * write failed. The HTTP layer carries it in `HttpErrorEnvelope`.
   */
  readonly _id?: string;
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

  /**
   * `true` iff re-running the operation from its read step can succeed:
   * `NetworkError` (retry with backoff) and `WriteConflict` (re-read, then
   * write again). A `Collection` / `Query` verb re-reads on every call, so
   * calling it again is the retry; a blind resend of the same conditional
   * `Storage` put loses again. A pure function of `code`
   * ({@link isRetriableCode}): every instance of a code gives the same
   * answer. `AmbiguousCommit` is `false` because the write may have landed;
   * reconcile by `_id` first.
   */
  get retriable(): boolean {
    return isRetriableCode(this.code);
  }

  /**
   * `code` and `message` are positional; everything else goes in `options`,
   * as with `new Error(message, { cause })`. Passing an `Error` (or any
   * non-options value) as the third argument does not compile; the
   * options object is where `cause` goes.
   *
   * @example
   * ```ts
   * throw new BaerlyError("NetworkError", "PUT failed", { cause: err });
   * throw new BaerlyError("AmbiguousCommit", "commit outcome unknown", { _id: "t-1" });
   * ```
   */
  constructor(code: BaerlyErrorCode, message: string, options?: BaerlyErrorOptions) {
    super(message);
    this.name = "BaerlyError";
    this.code = code;
    this.cause = options?.cause;
    const { issues, status, resolution, _id } = options ?? {};
    // Stryker disable next-line ConditionalExpression: field declaration creates property with undefined value; mutation to true is equivalent
    if (issues !== undefined) {
      this.issues = issues;
    }
    // Stryker disable next-line ConditionalExpression: same rationale as `issues` above
    if (status !== undefined) {
      this.status = status;
    }
    // Stryker disable next-line ConditionalExpression: same rationale as `issues` above
    if (resolution !== undefined) {
      this.resolution = resolution;
    }
    // Stryker disable next-line ConditionalExpression: same rationale as `issues` above
    if (_id !== undefined) {
      this._id = _id;
    }
  }
}
