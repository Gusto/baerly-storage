/**
 * HTTP dispatcher. A small Hono `app` that implements the
 * five locked CRUD routes from `contract.ts`. Mounted into both
 * adapters (`@baerly/adapter-cloudflare` and `@baerly/adapter-node`);
 * the router itself is platform-agnostic — it accepts a single
 * `Request`, dispatches against a per-request `Db`, and returns a
 * `Response` whose body follows the `HttpOkEnvelope` /
 * `HttpErrorEnvelope` shapes.
 *
 * The anonymous `GET /v1/healthz` liveness probe is served by the
 * adapters directly (see `worker.ts` / `server.ts`) — keeping it
 * upstream of the router avoids spending a `Db.create` on every
 * load-balancer probe.
 *
 * `GET /v1/since` is appended to the same factory (see `./since.ts`
 * for the long-poll core). The Cloudflare adapter wraps Worker-side
 * GETs with `caches.default` *outside* `createRouter` so the router
 * stays platform-agnostic; that wrapper EXCLUDES `/v1/since` —
 * long-poll idleness is not a cache hit.
 */

import { Hono } from "hono/tiny";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  type BaerlyConfig,
  type ConsistencyLevel,
  BaerlyError,
  type DocumentData,
  type BaerlyErrorCode,
  type OrderSpec,
  type Predicate,
} from "@baerly/protocol";
import type { Db } from "../db.ts";
import {
  errorEnvelope,
  type HttpErrorEnvelope,
  type HttpOkEnvelope,
  type HttpStatus,
  type SinceResponse,
} from "../contract.ts";
import { serializeError } from "../observability/canonical.ts";
import { CATEGORY, getLogger } from "../observability/index.ts";
import { runAllWithMeta } from "../query.ts";
import { longPollSince } from "./since.ts";

/**
 * Options for {@link createRouter}.
 *
 * - `db` — single-tenant `Db` instance. The CF/Node adapters build a
 *   fresh `Db` per request (after the Verifier resolves the tenant)
 *   and hand it to a freshly-constructed router. The router itself
 *   is stateless and per-request — `app.fetch(req)` is the only
 *   entry point. The Verifier runs in the adapter (see `worker.ts` /
 *   `server.ts`) before `createRouter` is called; the router itself
 *   has no auth seam.
 */
export interface CreateRouterOptions {
  readonly db: Db<BaerlyConfig>;
  /** Override the long-poll budget. Forwarded to `longPollSince`. */
  readonly sinceTimeoutMs?: number;
  /** Override the long-poll inner-poll cadence. Forwarded to `longPollSince`. */
  readonly sincePollIntervalMs?: number;
}

/**
 * Build a Hono `app` that serves the CRUD routes:
 *
 *  - `GET    /v1/t/:table/:id` → read one document.
 *  - `GET    /v1/t/:table?where=<json>&order=<json>&limit=<n>` → list rows
 *    matching a predicate, optionally ordered and capped.
 *  - `POST   /v1/t/:table` → insert. Body: `{ doc }`. → `201 { _id }`.
 *  - `PATCH  /v1/t/:table/:id` → merge-patch. Body: `{ patch }`. → `200 { modified }`.
 *  - `PUT    /v1/t/:table/:id` → whole-doc replace. Body: `{ doc }`. → `200 { modified }`.
 *  - `DELETE /v1/t/:table/:id` → delete row by id. → `204`.
 *  - `GET    /v1/count?table=<name>&where=<json>` → scalar `{ count: N }`.
 *  - `GET    /v1/since?table=<name>&cursor=<opaque>` → long-poll log.
 *
 * @example
 * ```ts
 * import { createRouter, Db } from "baerly-storage";
 * import { MemoryStorage } from "baerly-storage";
 *
 * const db = Db.create({ storage: new MemoryStorage(), app: "tickets", tenant: "acme" });
 * const app = createRouter({ db });
 * // CF Workers:
 * export default { async fetch(req: Request) { return app.fetch(req); } };
 * ```
 */
export function createRouter(options: CreateRouterOptions): Hono {
  const { db, sinceTimeoutMs, sincePollIntervalMs } = options;
  const app = new Hono();

  // The router intentionally does NOT mount an observability
  // middleware. Production adapters (`@baerly/adapter-cloudflare`,
  // `@baerly/adapter-node`) open their own `ObservabilityContext`
  // BEFORE calling `createRouter().fetch` so they can stamp adapter-
  // owned fields (e.g. `cache_status`) before the cache wrapper
  // short-circuits. Standalone callers (tests, one-off harnesses) wrap
  // their request via `withHttpObservability` from
  // `@baerly/server`. Either way, one unit-of-work → exactly one
  // canonical line.

  // Read one — GET /v1/t/:table/:id
  app.get("/v1/t/:table/:id", async (c) => {
    const { table, id } = c.req.param();
    const consistency = parseConsistency(c.req.query("consistency"));
    const { rows, manifestPointer, fresh } = await runAllWithMeta(db.tableReadContext(table), {
      predicate: { _id: id } as Predicate<DocumentData>,
      order: undefined,
      limit: 1,
      consistency,
    });
    const row = rows[0];
    if (row === undefined) {
      throw new BaerlyError("NotFound", `No such row: ${id}`);
    }
    return c.json(
      {
        data: row,
        _meta: { manifest_pointer: manifestPointer, fresh },
      } satisfies HttpOkEnvelope<DocumentData>,
      200,
    );
  });

  // List — GET /v1/t/:table?where=<urlencoded-json>
  app.get("/v1/t/:table", async (c) => {
    const { table } = c.req.param();
    const predicate = parseWhereParam(c);
    const consistency = parseConsistency(c.req.query("consistency"));
    const order = parseOrder(c.req.query("order"));
    const limit = parseLimit(c.req.query("limit"));
    const { rows, manifestPointer, fresh } = await runAllWithMeta(db.tableReadContext(table), {
      predicate: predicate as Predicate<DocumentData>,
      order,
      limit,
      consistency,
    });
    return c.json(
      {
        data: rows,
        _meta: { manifest_pointer: manifestPointer, fresh },
      } satisfies HttpOkEnvelope<ReadonlyArray<DocumentData>>,
      200,
    );
  });

  // Insert — POST /v1/t/:table  Body: { doc }  → 201 { _id }
  app.post("/v1/t/:table", async (c) => {
    const { table } = c.req.param();
    const body = await readJsonBody(c, MAX_BODY_BYTES);
    const doc = assertJsonBodyField(body, "doc");
    const { _id } = await db.table(table).insert(doc as Partial<DocumentData> & DocumentData);
    return c.json({ _id }, 201);
  });

  // Patch — PATCH /v1/t/:table/:id  Body: { patch }
  app.patch("/v1/t/:table/:id", async (c) => {
    const { table, id } = c.req.param();
    const body = await readJsonBody(c, MAX_BODY_BYTES);
    const patch = assertJsonBodyField(body, "patch");
    const { modified } = await db
      .table(table)
      .where({ _id: id })
      .update(patch as Partial<DocumentData>);
    if (modified === 0) {
      throw new BaerlyError("NotFound", `No such row: ${id}`);
    }
    return c.json({ modified }, 200);
  });

  // Replace — PUT /v1/t/:table/:id  Body: { doc }
  // Whole-document overwrite (NOT merge-patch). Strict cardinality:
  // missing row → 404; row matches → emits one `op:"U"` log entry
  // with the post-image, dropping fields absent from `doc`.
  app.put("/v1/t/:table/:id", async (c) => {
    const { table, id } = c.req.param();
    const body = await readJsonBody(c, MAX_BODY_BYTES);
    const doc = assertJsonBodyField(body, "doc");
    try {
      await db
        .table(table)
        .where({ _id: id })
        .replace(doc as DocumentData);
    } catch (error) {
      // `Query.replace` raises `Conflict` with `expected exactly 1
      // match, got 0` when the row is missing. Translate to the
      // wire-level 404 NotFound the rest of the surface uses; let
      // every other Conflict (CAS exhaustion, schema violation, etc.)
      // bubble unchanged.
      if (
        error instanceof BaerlyError &&
        error.code === "Conflict" &&
        error.message.includes("got 0")
      ) {
        throw new BaerlyError("NotFound", `No such row: ${id}`);
      }
      throw error;
    }
    return c.json({ modified: 1 }, 200);
  });

  // Delete — DELETE /v1/t/:table/:id  → 204
  app.delete("/v1/t/:table/:id", async (c) => {
    const { table, id } = c.req.param();
    const { deleted } = await db.table(table).where({ _id: id }).delete();
    if (deleted === 0) {
      throw new BaerlyError("NotFound", `No such row: ${id}`);
    }
    return new Response(null, { status: 204 });
  });

  // Count — GET /v1/count?table=<name>&where=<json>&consistency=<level>
  //
  // Returns a scalar row count for the matching predicate. Avoids the
  // client downloading every row just to take `.length` (silent egress
  // burn). Engine cost is currently the same as `runAllWithMeta` — the
  // win is wire bytes; an O(snapshot+log) count path can land later
  // without touching this route.
  app.get("/v1/count", async (c) => {
    const table = c.req.query("table");
    if (table === undefined || table.length === 0) {
      throw new BaerlyError("SchemaError", "GET /v1/count requires ?table=<name>");
    }
    const predicate = parseWhereParam(c);
    const consistency = parseConsistency(c.req.query("consistency"));
    const { rows, manifestPointer, fresh } = await runAllWithMeta(db.tableReadContext(table), {
      predicate: predicate as Predicate<DocumentData>,
      order: undefined,
      limit: undefined,
      consistency,
    });
    return c.json(
      {
        data: { count: rows.length },
        _meta: { manifest_pointer: manifestPointer, fresh },
      } satisfies HttpOkEnvelope<{ count: number }>,
      200,
    );
  });

  // Long-poll — GET /v1/since?table=<name>&cursor=<opaque>
  //
  // Cache-API note: the Cloudflare adapter's `caches.default` wrapper
  // explicitly EXCLUDES `/v1/since` — long-poll idleness is not a
  // cache hit. The adapter middleware MUST check the path before
  // consulting the cache. Do NOT add cache reads here.
  app.get("/v1/since", async (c) => {
    // The router does NOT set `c.var.db`; the adapter resolves the
    // Verifier BEFORE `createRouter` is called and the resulting `db`
    // is captured in this closure. The handler reads it from the
    // outer scope, not from `c.var`.
    const table = c.req.query("table");
    if (typeof table !== "string" || table.length === 0 || table.includes("/")) {
      throw new BaerlyError(
        "SchemaError",
        "GET /v1/since requires a non-empty `table` query parameter without `/`",
      );
    }
    const cursor = c.req.query("cursor") ?? "";
    const result = await longPollSince({
      db,
      table,
      cursor,
      signal: c.req.raw.signal,
      timeoutMs: sinceTimeoutMs,
      pollIntervalMs: sincePollIntervalMs,
    });
    // 200 covers both "new events present" and "timeout idle" —
    // see `./since.ts` module JSDoc for why we don't use 304.
    return c.json(result satisfies SinceResponse, 200);
  });

  app.onError((err, c) => mapToResponse(c, err));

  return app;
}

/**
 * Hard cap on request-body bytes. 1 MiB — matches `S3HttpStorage`'s
 * conformance-suite default. Over-cap → `413 PayloadTooLarge`.
 *
 * The Node adapter (`@baerly/adapter-node`) imports this constant
 * and passes it to `applyBodyCap`, which wraps the request body
 * with a counting `TransformStream` so chunked uploads trip the cap
 * mid-stream rather than materialising the full buffer. The
 * router's `readJsonBody` keeps the cap as a defence-in-depth check
 * (Content-Length pre-read + post-`arrayBuffer` length) for adapters
 * whose platform doesn't pre-cap.
 *
 * @internal — exported for tests and for the Node adapter's
 *   `applyBodyCap` helper. Promote to
 *   `packages/protocol/src/constants.ts` only on a third cross-
 *   package consumer.
 */
export const MAX_BODY_BYTES = 1 << 20; // 1 MiB; matches `S3HttpStorage`'s conformance-suite default.

/**
 * Assert that `body[field]` is a plain object (not undefined / null /
 * array / primitive). Returns the value typed as
 * `Record<string, unknown>` so the caller's next cast doesn't need
 * another guard. Throws `BaerlyError{code:"SchemaError"}` with the
 * locked wording `"Request body must be { <field>: object }"`.
 *
 * Used by POST `/v1/t/:table` (`doc`), PATCH `/v1/t/:table/:id`
 * (`patch`), and PUT `/v1/t/:table/:id` (`doc`).
 *
 * @internal
 */
const assertJsonBodyField = (body: unknown, field: string): Record<string, unknown> => {
  const value =
    typeof body === "object" && body !== null
      ? (body as Record<string, unknown>)[field]
      : undefined;
  if (value === undefined || typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BaerlyError("SchemaError", `Request body must be { ${field}: object }`);
  }
  return value as Record<string, unknown>;
};

/**
 * Parse the `?where=<urlencoded JSON>` query-string param. Absent or
 * empty → `{}` (match-all). Malformed JSON → `BaerlyError{code:"SchemaError"}`
 * with the locked wording `"Invalid JSON in ?where="`. Returns the
 * parsed object widened to `Record<string, unknown>`; callers cast
 * to `Predicate<DocumentData>` after.
 *
 * @internal
 */
const parseWhereParam = (c: Context): Record<string, unknown> => {
  const whereParam = c.req.query("where");
  if (whereParam === undefined || whereParam.length === 0) {
    return {};
  }
  try {
    return JSON.parse(whereParam) as Record<string, unknown>;
  } catch {
    throw new BaerlyError("SchemaError", "Invalid JSON in ?where=");
  }
};

/**
 * Parse the `?consistency=...` query-string param. Absent →
 * `"strong"`. Known values → that value. Anything else →
 * `BaerlyError{code:"InvalidConfig"}` (mapped to 400 by
 * {@link mapToResponse}).
 *
 * Mutation routes silently ignore `?consistency` per the locked
 * contract (writes are always strong); only the two read routes
 * call this.
 *
 * @internal
 */
function parseConsistency(raw: string | undefined): ConsistencyLevel {
  if (raw === undefined) {
    return "strong";
  }
  if (raw === "strong" || raw === "eventual") {
    return raw;
  }
  throw new BaerlyError(
    "InvalidConfig",
    `?consistency must be "strong" or "eventual"; got ${JSON.stringify(raw)}`,
  );
}

/**
 * Parse `?limit=<n>` as a non-negative safe integer. Returns
 * `undefined` when absent. Rejects floats, NaN, negatives, and
 * non-numeric input with `SchemaError`.
 *
 * @internal
 */
function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new BaerlyError(
      "SchemaError",
      `?limit= must be a non-negative integer; got ${JSON.stringify(raw)}`,
    );
  }
  return n;
}

/**
 * Parse the `?order=<json>` query param. Mirrors the `?where=` parser
 * shape: undefined → no order, malformed JSON → `SchemaError`. The
 * engine (`runAllWithMeta` → `sortByOrderSpec`) validates the shape
 * itself, so this only handles the wire-level JSON decode.
 *
 * @internal
 */
function parseOrder(raw: string | undefined): OrderSpec<DocumentData> | undefined {
  if (raw === undefined || raw.length === 0) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BaerlyError("SchemaError", "Invalid JSON in ?order=");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new BaerlyError("SchemaError", "?order= must encode a JSON object");
  }
  return parsed as OrderSpec<DocumentData>;
}

const ERROR_TO_STATUS: ReadonlyMap<BaerlyErrorCode, HttpStatus> = new Map<
  BaerlyErrorCode,
  HttpStatus
>([
  ["Unauthorized", 401],
  ["AccessDenied", 403],
  ["NotFound", 404],
  ["Conflict", 409],
  ["PayloadTooLarge", 413],
  ["SchemaError", 400],
  ["InvalidConfig", 400],
  // NetworkError, InvalidResponse, Internal → 500
]);

/**
 * Map an unknown thrown value onto the wire envelope plus an HTTP
 * status code. The mapping is keyed by `BaerlyError.code` so any future
 * code addition forces a re-check here (currently unmapped codes fall
 * through to 500 by design — see the `NetworkError` / `InvalidResponse`
 * / `Internal` comment in `ERROR_TO_STATUS`).
 *
 * @internal — exported for tests and for the `/v1/since` long-poll
 *   handler in `./since.ts`. The `HttpErrorEnvelope` shape is locked;
 *   do not mutate it.
 */
export function mapError(err: unknown): { status: HttpStatus; envelope: HttpErrorEnvelope } {
  if (err instanceof BaerlyError) {
    const status = ERROR_TO_STATUS.get(err.code) ?? 500;
    return { status, envelope: errorEnvelope(err.code, err.message, err.issues) };
  }
  // Unknown thrown value: the message may carry internal detail
  // (file paths, bucket names, upstream response bodies). Log on the
  // server side via the observability channel (replaces the legacy
  // bare `console.error`) and return a generic envelope to the
  // client. The mapped-error wire shape itself is locked and does
  // NOT change here.
  getLogger(CATEGORY.http).error("unhandled_error", { error: serializeError(err) });
  return { status: 500, envelope: errorEnvelope("Internal", "internal error") };
}

// Hono-context shortcut used by every handler's catch block.
function mapToResponse(c: Context, err: unknown): Response {
  const { status, envelope } = mapError(err);
  // `mapError` only returns 4xx/5xx — all of which are
  // `ContentfulStatusCode`. The cast bridges the locked `HttpStatus`
  // union (which also includes 204/304 for the wider contract) to
  // Hono's narrower body-bearing subset.
  return c.json(envelope, status as ContentfulStatusCode);
}

/**
 * Read and parse the JSON request body. Returns the parsed value
 * (an `unknown` — caller narrows). Throws `BaerlyError`:
 *
 *   - `"PayloadTooLarge"` (→ 413) when the body exceeds `maxBytes`,
 *     detected via `Content-Length` pre-check, post-`arrayBuffer`
 *     length check, or — if the host adapter pumps the body through
 *     a `ReadableStream` (the Node adapter does) — a `BaerlyError`
 *     surfaced via `controller.error(...)` on the upstream pump.
 *   - `"SchemaError"` (→ 400) for empty bodies, JSON parse failures,
 *     and any other read failure.
 *
 * Hono's `app.onError` sink routes the throw through `mapToResponse`.
 */
async function readJsonBody(c: Context, maxBytes: number): Promise<unknown> {
  const lenHeader = c.req.header("content-length");
  if (lenHeader !== undefined) {
    const parsed = Number.parseInt(lenHeader, 10);
    if (Number.isFinite(parsed) && parsed > maxBytes) {
      throw new BaerlyError("PayloadTooLarge", `Body exceeds ${maxBytes} bytes`);
    }
  }
  // Read with an early-exit guard for chunked transfers. If the
  // upstream adapter (e.g. `@baerly/adapter-node`) caps the body at
  // the stream-pump layer, the rejected `arrayBuffer()` carries a
  // `BaerlyError{code:"PayloadTooLarge"}` which we re-throw verbatim;
  // any other read failure becomes a 400 SchemaError.
  let raw: string;
  try {
    const buffer = await c.req.arrayBuffer();
    if (buffer.byteLength > maxBytes) {
      throw new BaerlyError("PayloadTooLarge", `Body exceeds ${maxBytes} bytes`);
    }
    raw = new TextDecoder().decode(buffer);
  } catch (error) {
    if (error instanceof BaerlyError) {
      throw error;
    }
    throw new BaerlyError(
      "SchemaError",
      `Failed to read request body: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (raw.length === 0) {
    throw new BaerlyError("SchemaError", "Empty request body");
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new BaerlyError("SchemaError", "Invalid JSON in request body");
  }
}
