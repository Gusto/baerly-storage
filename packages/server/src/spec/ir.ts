import {
  type BaerlyErrorCode,
  CLIENT_RUNTIME_CODES,
  ERROR_CODES,
  isRetriableCode,
  PREDICATE_OPS,
} from "@baerly/protocol";
// Read the ROOT package.json version: `@gusto/baerly-storage` is published
// from the monorepo root under changesets lockstep, so the root version is
// the kernel/published version — deliberately NOT server's internal
// workspace version. buildSpecIR is build/test-time only (never bundled), so
// the path reach is contained; a moved/restructured root fails loudly at
// `pnpm gen:spec` rather than silently emitting a wrong version.
import pkg from "../../../../package.json" with { type: "json" };
import { ERROR_TO_STATUS, errorMessagePolicyFor, type ErrorMessagePolicy } from "../http/router.ts";

/** Machine-readable contract IR. Validated against `protocol/src/spec/ir-schema.json`. */
export interface SpecIR {
  readonly $schema: string;
  readonly specVersion: string;
  readonly kernelVersion: string;
  readonly errorCodes: ReadonlyArray<{
    readonly code: BaerlyErrorCode;
    // `null` for codes raised only in the client runtime (they never
    // travel HTTP); a number for every code the HTTP layer can return.
    readonly httpStatus: number | null;
    readonly retriable: boolean;
    readonly messagePolicy: ErrorMessagePolicy | "not-on-http";
    readonly summary: string;
  }>;
  readonly operators: ReadonlyArray<{
    readonly name: string;
    readonly valueType: "equality" | "range" | "set";
    readonly summary: string;
  }>;
  readonly collectionMethods: ReadonlyArray<SpecMethod>;
  readonly queryMethods: ReadonlyArray<SpecMethod>;
  readonly storageInterface: ReadonlyArray<SpecMethod>;
  readonly predicateWire: { readonly clause: object; readonly envelope: object };
  readonly schemaContract: {
    readonly adapter: string;
    readonly validatesPostImage: boolean;
    readonly idRequired: boolean;
    readonly rejectsWith: string;
  };
  readonly httpRoutes: ReadonlyArray<{
    readonly method: string;
    readonly path: string;
    readonly auth: "anonymous" | "verified";
    readonly summary?: string;
  }>;
}

interface SpecMethod {
  readonly name: string;
  readonly params: string;
  readonly returns: string;
  readonly throws?: ReadonlyArray<string>;
  readonly summary?: string;
}

// Curated one-line summaries per error code. Enumeration completeness is
// gated (every ERROR_CODES member must appear); summary TEXT is curated
// (owner-accepted curated fidelity). Keep terse.
const ERROR_SUMMARY: Record<BaerlyErrorCode, string> = {
  InvalidConfig: "Caller config or input is invalid.",
  NetworkError: "S3/HTTP transport failure (5xx, retries exhausted).",
  AccessDenied: "S3 returned 403 — credentials or bucket policy.",
  InvalidResponse: "Server returned unparseable data.",
  Internal: "Internal invariant violation — file a bug.",
  SchemaError: "Document body failed schema validation; carries .issues.",
  Conflict: "Write conflicted (CAS exhausted, duplicate _id, guarded key).",
  Unauthorized: "Verifier returned no identity.",
  NotFound: "Addressed resource does not exist.",
  PayloadTooLarge: "Request body exceeded MAX_BODY_BYTES.",
  UnsatisfiablePredicate: "Predicate is well-formed but contradicts itself.",
  UseQueryAwaitedRecorder: "A useQuery callback awaited a recorder terminal.",
  UnexpectedWriteInQuery: "A write verb was called inside a useQuery callback.",
  MutationFailed: "A useMutation callback rejected with a non-BaerlyError.",
};

const OPERATOR_META: Record<
  (typeof PREDICATE_OPS)[number],
  { valueType: "equality" | "range" | "set"; summary: string }
> = {
  eq: { valueType: "equality", summary: "Strict equality." },
  gt: { valueType: "range", summary: "Greater-than; bound is string or finite number." },
  gte: { valueType: "range", summary: "Greater-or-equal; bound is string or finite number." },
  lt: { valueType: "range", summary: "Less-than; bound is string or finite number." },
  lte: { valueType: "range", summary: "Less-or-equal; bound is string or finite number." },
  in: { valueType: "set", summary: "Set membership; empty array → UnsatisfiablePredicate." },
};

// Curated method tables. Names + return shapes match the live Collection<T> /
// Query<T> / Storage interfaces; param strings are curated (owner-accepted fidelity).
const COLLECTION_METHODS: ReadonlyArray<SpecMethod> = [
  { name: "first", params: "", returns: "Promise<T | undefined>" },
  { name: "all", params: "", returns: "Promise<T[]>" },
  { name: "count", params: "", returns: "Promise<number>" },
  { name: "get", params: "id: string", returns: "Promise<T | undefined>" },
  { name: "where", params: "predicate: PredicateArg<T>", returns: "Query<T>" },
  { name: "order", params: "spec: OrderSpec<T>", returns: "Query<T>" },
  { name: "limit", params: "n: number", returns: "Query<T>" },
  {
    name: "insert",
    params: "doc: Partial<T> & DocumentData",
    returns: "Promise<{ _id: string }>",
    throws: ["SchemaError", "Conflict"],
  },
  {
    name: "update",
    params: "id: string, patch: Partial<T>",
    returns: "Promise<{ modified: number }>",
    throws: ["SchemaError", "Conflict"],
  },
  {
    name: "replace",
    params: "id: string, doc: T",
    returns: "Promise<void>",
    throws: ["SchemaError", "Conflict", "NotFound"],
  },
  {
    name: "delete",
    params: "id: string",
    returns: "Promise<{ deleted: number }>",
    throws: ["Conflict"],
  },
];

const QUERY_METHODS: ReadonlyArray<SpecMethod> = [
  { name: "where", params: "predicate: PredicateArg<T>", returns: "Query<T>" },
  { name: "order", params: "spec: OrderSpec<T>", returns: "Query<T>" },
  { name: "limit", params: "n: number", returns: "Query<T>" },
  { name: "first", params: "", returns: "Promise<T | undefined>" },
  { name: "all", params: "", returns: "Promise<T[]>" },
  { name: "count", params: "", returns: "Promise<number>" },
  {
    name: "update",
    params: "patch: Partial<T>",
    returns: "Promise<{ modified: number }>",
    throws: ["SchemaError", "Conflict"],
  },
  { name: "delete", params: "", returns: "Promise<{ deleted: number }>", throws: ["Conflict"] },
];

const STORAGE_INTERFACE: ReadonlyArray<SpecMethod> = [
  {
    name: "get",
    params: "key: string, opts?: StorageGetOptions",
    returns: "Promise<StorageGetResult | null>",
  },
  {
    name: "put",
    params: "key: string, body: Uint8Array, opts?: StoragePutOptions",
    returns: "Promise<StoragePutResult>",
  },
  {
    name: "delete",
    params: "key: string, opts?: { signal?: AbortSignal }",
    returns: "Promise<void>",
  },
  {
    name: "list",
    params:
      "prefix: string, opts?: { startAfter?: string; maxKeys?: number; signal?: AbortSignal }",
    returns: "AsyncIterable<StorageListEntry>",
  },
];

const HTTP_ROUTES: SpecIR["httpRoutes"] = [
  { method: "GET", path: "/v1/healthz", auth: "anonymous", summary: "Liveness probe." },
  {
    method: "GET",
    path: "/v1/spec",
    auth: "anonymous",
    summary: "Machine-readable contract; tenant collections only when authed.",
  },
  {
    method: "GET",
    path: "/v1/c/:collection",
    auth: "verified",
    summary: "Read/query a collection (?where=, ?order=, ?limit=).",
  },
  {
    method: "GET",
    path: "/v1/c/:collection/:id",
    auth: "verified",
    summary: "Read one document by id (404 when absent).",
  },
  { method: "POST", path: "/v1/c/:collection", auth: "verified", summary: "Insert a document." },
  {
    method: "PATCH",
    path: "/v1/c/:collection/:id",
    auth: "verified",
    summary: "Merge-patch a document by id (body { patch }).",
  },
  {
    method: "PUT",
    path: "/v1/c/:collection/:id",
    auth: "verified",
    summary: "Replace a document by id (body { doc }).",
  },
  {
    method: "DELETE",
    path: "/v1/c/:collection/:id",
    auth: "verified",
    summary: "Delete a document by id (204; 404 when absent).",
  },
  { method: "GET", path: "/v1/count", auth: "verified", summary: "Count matching rows." },
  {
    method: "GET",
    path: "/v1/since",
    auth: "verified",
    summary: "Long-poll the collection log tail.",
  },
];

/**
 * Build the machine-readable contract IR from the canonical kernel
 * enumerations + curated method/route tables. Build/test-time ONLY —
 * the runtime route imports the generated JSON as data, never this
 * module (which would drag the http router into the kernel closure).
 */
export function buildSpecIR(): SpecIR {
  return {
    $schema: "https://baerly.dev/spec/ir-schema.json",
    specVersion: "1",
    kernelVersion: pkg.version,
    errorCodes: ERROR_CODES.map((code) => ({
      code,
      // Mapped status if the HTTP layer has one; otherwise `null` for
      // client-runtime-only codes (never on the wire) and `500` for
      // server-side codes that mapError falls through to a 500.
      httpStatus: ERROR_TO_STATUS.get(code) ?? (CLIENT_RUNTIME_CODES.has(code) ? null : 500),
      retriable: isRetriableCode(code),
      messagePolicy: CLIENT_RUNTIME_CODES.has(code) ? "not-on-http" : errorMessagePolicyFor(code),
      summary: ERROR_SUMMARY[code],
    })),
    operators: PREDICATE_OPS.map((name) => ({
      name,
      valueType: OPERATOR_META[name].valueType,
      summary: OPERATOR_META[name].summary,
    })),
    collectionMethods: COLLECTION_METHODS,
    queryMethods: QUERY_METHODS,
    storageInterface: STORAGE_INTERFACE,
    predicateWire: {
      clause: {
        op: "PredicateOpName",
        field: "string (top-level key or dotted path)",
        value: "DocumentValue | DocumentValue[] (array iff op==='in')",
      },
      envelope: { clauses: "PredicateClause[] (AND across clauses; empty → match-all)" },
    },
    schemaContract: {
      adapter: "StandardSchemaV1",
      validatesPostImage: true,
      idRequired: true,
      rejectsWith: "SchemaError",
    },
    httpRoutes: HTTP_ROUTES,
  };
}
