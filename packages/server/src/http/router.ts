/**
 * Phase-6 HTTP dispatcher. A small Hono `app` that implements the
 * five locked CRUD routes from `contract.ts` plus an anonymous
 * `/v1/healthz` liveness probe. Mounted into both adapters
 * (`@baerly/adapter-cloudflare` and `@baerly/adapter-node`); the
 * router itself is platform-agnostic — it accepts a single
 * `Request`, dispatches against a per-request `Db`, and returns a
 * `Response` whose body follows the `HttpOkEnvelope` /
 * `HttpErrorEnvelope` shapes.
 *
 * Ticket 26 appends `GET /v1/since` to the same factory (see
 * `./since.ts` for the long-poll core). Ticket 27 wraps the
 * Worker-side GETs with `caches.default` *outside* `createRouter` so
 * the router stays platform-agnostic; ticket 27 also EXCLUDES
 * `/v1/since` — long-poll idleness is not a cache hit.
 */

import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  type ConsistencyLevel,
  BaerlyError,
  type JSONArraylessObject,
  type BaerlyErrorCode,
  type Predicate,
  type Verifier,
} from "@baerly/protocol";
import type { Db } from "../db";
import type { HttpErrorEnvelope, HttpOkEnvelope, HttpStatus, SinceResponse } from "../contract";
import { runAllWithMeta, runFirstWithMeta } from "../query";
import { longPollSince } from "./since";

/**
 * Options for {@link createRouter}.
 *
 * - `db` — single-tenant `Db` instance. The CF/Node adapters build a
 *   fresh `Db` per request (after the Verifier resolves the tenant)
 *   and hand it to a freshly-constructed router. The router itself
 *   is stateless and per-request — `app.fetch(req)` is the only
 *   entry point.
 * - `verifier` — optional. When set, `createRouter` mounts an
 *   `app.use("/v1/t/*", ...)` middleware that calls the verifier on
 *   every CRUD request and rejects null with 401. Adapters that
 *   resolve the tenant **before** constructing the `Db` (the
 *   recommended flow — see `worker.ts` / `server.ts`) pass
 *   `verifier: undefined` here and call the Verifier themselves;
 *   router-level Verifier support is for callers who want a single
 *   mount point.
 * - `healthCheck` — default `true`. Mounts `GET /v1/healthz` →
 *   `200 {"ok": true}` bypassing the verifier. Set `false` when the
 *   adapter already served healthz upstream (it should, to keep the
 *   probe hot path off `Db.create`).
 */
export interface CreateRouterOptions {
  readonly db: Db;
  readonly verifier?: Verifier;
  readonly healthCheck?: boolean;
}

/**
 * Build a Hono `app` that serves the Phase-6 CRUD routes:
 *
 *  - `GET    /v1/t/:table/:id` → read one document.
 *  - `GET    /v1/t/:table?where=<json>` → list rows matching a predicate.
 *  - `POST   /v1/t/:table` → insert. Body: `{ doc }`. → `201 { _id }`.
 *  - `PATCH  /v1/t/:table/:id` → merge-patch. Body: `{ patch }`.
 *  - `DELETE /v1/t/:table/:id` → delete row by id. → `204`.
 *  - `GET    /v1/healthz` (when `healthCheck !== false`) → liveness probe.
 *  - `GET    /v1/since?table=<name>&cursor=<opaque>` → long-poll log.
 *
 * @example
 * ```ts
 * import { createRouter, Db } from "@baerly/server";
 * import { MemoryStorage } from "@baerly/protocol";
 *
 * const db = Db.create({ storage: new MemoryStorage(), app: "tickets", tenant: "acme" });
 * const app = createRouter({ db });
 * // CF Workers:
 * export default { async fetch(req: Request) { return app.fetch(req); } };
 * ```
 */
export function createRouter(options: CreateRouterOptions): Hono {
  const { db, verifier, healthCheck = true } = options;
  const app = new Hono();

  if (healthCheck) {
    app.get("/v1/healthz", (c) => c.json({ ok: true }, 200));
  }

  // Optional in-router Verifier middleware. Adapters that resolve
  // the tenant BEFORE constructing the Db (recommended path; see
  // worker.ts / server.ts) skip this branch — the Db handed in
  // already pins the tenant. This mount is a convenience for
  // single-mount-point callers; it does NOT re-derive the Db.
  if (verifier !== undefined) {
    app.use("/v1/t/*", async (c, next) => {
      const result = await verifier(c.req.raw);
      if (result === null) {
        return jsonError(c, 401, "Unauthorized", "Verifier returned null");
      }
      await next();
      return undefined;
    });
  }

  // Read one — GET /v1/t/:table/:id
  app.get("/v1/t/:table/:id", async (c) => {
    const { table, id } = c.req.param();
    try {
      const consistency = parseConsistency(c.req.query("consistency"));
      const { row, manifestPointer, fresh } = await runFirstWithMeta(db.tableReadContext(table), {
        predicate: { _id: id } as Predicate<JSONArraylessObject>,
        order: undefined,
        limit: 1,
        consistency,
      });
      if (row === undefined) return jsonError(c, 404, "NotFound", `No such row: ${id}`);
      return c.json(
        {
          data: row,
          _meta: { manifest_pointer: manifestPointer, fresh },
        } satisfies HttpOkEnvelope<JSONArraylessObject>,
        200,
      );
    } catch (e) {
      return mapToResponse(c, e);
    }
  });

  // List — GET /v1/t/:table?where=<urlencoded-json>
  app.get("/v1/t/:table", async (c) => {
    const { table } = c.req.param();
    const whereParam = c.req.query("where");
    let predicate: Record<string, unknown> = {};
    if (whereParam !== undefined && whereParam.length > 0) {
      try {
        predicate = JSON.parse(whereParam) as Record<string, unknown>;
      } catch {
        return jsonError(c, 400, "SchemaError", "Invalid JSON in ?where=");
      }
    }
    try {
      const consistency = parseConsistency(c.req.query("consistency"));
      const { rows, manifestPointer, fresh } = await runAllWithMeta(db.tableReadContext(table), {
        predicate: predicate as Predicate<JSONArraylessObject>,
        order: undefined,
        limit: undefined,
        consistency,
      });
      return c.json(
        {
          data: rows,
          _meta: { manifest_pointer: manifestPointer, fresh },
        } satisfies HttpOkEnvelope<ReadonlyArray<JSONArraylessObject>>,
        200,
      );
    } catch (e) {
      return mapToResponse(c, e);
    }
  });

  // Insert — POST /v1/t/:table  Body: { doc }  → 201 { _id }
  app.post("/v1/t/:table", async (c) => {
    const { table } = c.req.param();
    const body = await readJsonBody(c, MAX_BODY_BYTES);
    if (body.kind === "err") return jsonError(c, body.status, body.code, body.message);
    const { doc } = body.value as { doc?: unknown };
    if (doc === undefined || typeof doc !== "object" || doc === null || Array.isArray(doc)) {
      return jsonError(c, 400, "SchemaError", "Request body must be { doc: object }");
    }
    try {
      const { _id } = await db
        .table(table)
        .insert(doc as Partial<JSONArraylessObject> & JSONArraylessObject);
      return c.json({ _id }, 201);
    } catch (e) {
      return mapToResponse(c, e);
    }
  });

  // Patch — PATCH /v1/t/:table/:id  Body: { patch }
  app.patch("/v1/t/:table/:id", async (c) => {
    const { table, id } = c.req.param();
    const body = await readJsonBody(c, MAX_BODY_BYTES);
    if (body.kind === "err") return jsonError(c, body.status, body.code, body.message);
    const { patch } = body.value as { patch?: unknown };
    if (
      patch === undefined ||
      typeof patch !== "object" ||
      patch === null ||
      Array.isArray(patch)
    ) {
      return jsonError(c, 400, "SchemaError", "Request body must be { patch: object }");
    }
    try {
      const { modified } = await db
        .table(table)
        .where({ _id: id } as Predicate<JSONArraylessObject>)
        .update(patch as Partial<JSONArraylessObject>);
      if (modified === 0) return jsonError(c, 404, "NotFound", `No such row: ${id}`);
      return c.json({ data: { modified } }, 200);
    } catch (e) {
      return mapToResponse(c, e);
    }
  });

  // Delete — DELETE /v1/t/:table/:id  → 204
  app.delete("/v1/t/:table/:id", async (c) => {
    const { table, id } = c.req.param();
    try {
      const { deleted } = await db
        .table(table)
        .where({ _id: id } as Predicate<JSONArraylessObject>)
        .delete();
      if (deleted === 0) return jsonError(c, 404, "NotFound", `No such row: ${id}`);
      return new Response(null, { status: 204 });
    } catch (e) {
      return mapToResponse(c, e);
    }
  });

  // Long-poll — GET /v1/since?table=<name>&cursor=<opaque>
  //
  // Cache-API note (ticket 27 will wire `caches.default` for read
  // paths): `/v1/since` is explicitly EXCLUDED — long-poll idleness
  // is not a cache hit. Ticket 27's middleware MUST check the path
  // before consulting the cache. Do NOT add cache reads here.
  app.get("/v1/since", async (c) => {
    // Ticket 25 does NOT set `c.var.db`; the adapter resolves the
    // Verifier BEFORE `createRouter` is called and the resulting `db`
    // is captured in this closure. The handler reads it from the
    // outer scope, not from `c.var`.
    const table = c.req.query("table");
    if (typeof table !== "string" || table.length === 0 || table.includes("/")) {
      return jsonError(
        c,
        400,
        "SchemaError",
        "GET /v1/since requires a non-empty `table` query parameter without `/`",
      );
    }
    const cursor = c.req.query("cursor") ?? "";
    try {
      const result = await longPollSince({
        db,
        table,
        cursor,
        signal: c.req.raw.signal,
      });
      // 200 covers both "new events present" and "timeout idle" —
      // see ticket 26 §4.5 for why we don't use 304.
      return c.json(result satisfies SinceResponse, 200);
    } catch (e) {
      return mapToResponse(c, e);
    }
  });

  return app;
}

/**
 * Hard cap on request-body bytes. 1 MiB — matches `S3HttpStorage`'s
 * conformance-suite default. Over-cap → `413 PayloadTooLarge`.
 *
 * The Node adapter (`@baerly/adapter-node`) imports this constant
 * and enforces it during the `node:http` stream pump so the process
 * never materializes a multi-MiB body. The router's `readJsonBody`
 * keeps the cap as a defence-in-depth check for adapters whose
 * platform doesn't pre-cap.
 *
 * @internal — exported for tests and for the Node adapter's stream
 *   pump. Promote to `packages/protocol/src/constants.ts` only on a
 *   third cross-package consumer.
 */
export const MAX_BODY_BYTES = 1 << 20; // 1 MiB; see Q5 of ticket 25.

/**
 * Parse the `?consistency=...` query-string param. Absent →
 * `"strong"`. Known values → that value. Anything else →
 * `BaerlyError{code:"InvalidConfig"}` (mapped to 400 by
 * {@link mapToResponse}).
 *
 * Mutation routes silently ignore `?consistency` per the locked
 * contract (writes are always strong); only the two read routes
 * call this. See ticket 34 §3.4.
 *
 * @internal
 */
function parseConsistency(raw: string | undefined): ConsistencyLevel {
  if (raw === undefined) return "strong";
  if (raw === "strong" || raw === "eventual") return raw;
  throw new BaerlyError(
    "InvalidConfig",
    `?consistency must be "strong" or "eventual"; got ${JSON.stringify(raw)}`,
  );
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
  // OfflineNoCache, NetworkError, InvalidResponse, Internal → 500
]);

/**
 * Map an unknown thrown value onto the wire envelope plus an HTTP
 * status code. The mapping is keyed by `BaerlyError.code` so any future
 * code addition forces a re-check here (currently unmapped codes fall
 * through to 500 by design — see the `OfflineNoCache` / `NetworkError`
 * / `InvalidResponse` / `Internal` comment in `ERROR_TO_STATUS`).
 *
 * @internal — exported for tests and for ticket 26's `/v1/since`
 *   handler. The `HttpErrorEnvelope` shape is locked at Phase 2; do
 *   not mutate it.
 */
export function mapError(err: unknown): { status: HttpStatus; envelope: HttpErrorEnvelope } {
  if (err instanceof BaerlyError) {
    const status = ERROR_TO_STATUS.get(err.code) ?? 500;
    return {
      status,
      envelope: { error: { code: err.code, message: err.message } },
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    status: 500,
    envelope: { error: { code: "Internal", message } },
  };
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

// Inline-error shortcut. The router never has to allocate an
// BaerlyError just to short-circuit a 400 — callers pass a code +
// message string and we build the envelope here.
function jsonError(
  c: Context,
  status: HttpStatus,
  code: BaerlyErrorCode,
  message: string,
): Response {
  // Every `jsonError` call site passes a 4xx status (errors carry a
  // body). Cast bridges `HttpStatus` → `ContentfulStatusCode` for
  // Hono's `c.json` overload.
  return c.json(
    { error: { code, message } } satisfies HttpErrorEnvelope,
    status as ContentfulStatusCode,
  );
}

/**
 * Result discriminant from {@link readJsonBody}. The `err` branch
 * carries a structured `code` so callers can route to the right
 * `HttpStatus` without switching on free-form `message` strings.
 *
 * Today only two codes are produced:
 *   - `"PayloadTooLarge"` (413) when the body exceeds `maxBytes`,
 *     detected via `Content-Length` pre-check, post-`arrayBuffer`
 *     length check, or — if the host adapter pumps the body through
 *     a `ReadableStream` (the Node adapter does) — a `BaerlyError`
 *     surfaced via `controller.error(...)` on the upstream pump.
 *   - `"SchemaError"` (400) for empty bodies, JSON parse failures,
 *     and any other read failure.
 */
type ReadJsonResult =
  | { readonly kind: "ok"; readonly value: unknown }
  | {
      readonly kind: "err";
      readonly code: "PayloadTooLarge" | "SchemaError";
      readonly status: HttpStatus;
      readonly message: string;
    };

async function readJsonBody(c: Context, maxBytes: number): Promise<ReadJsonResult> {
  const lenHeader = c.req.header("content-length");
  if (lenHeader !== undefined) {
    const parsed = Number.parseInt(lenHeader, 10);
    if (Number.isFinite(parsed) && parsed > maxBytes) {
      return {
        kind: "err",
        code: "PayloadTooLarge",
        status: 413,
        message: `Body exceeds ${maxBytes} bytes`,
      };
    }
  }
  // Read with an early-exit guard for chunked transfers. If the
  // upstream adapter (e.g. `@baerly/adapter-node`) caps the body at
  // the stream-pump layer, the rejected `arrayBuffer()` carries a
  // `BaerlyError{code:"PayloadTooLarge"}` which we surface as 413
  // here; any other read failure becomes a 400 SchemaError.
  let raw: string;
  try {
    const buffer = await c.req.arrayBuffer();
    if (buffer.byteLength > maxBytes) {
      return {
        kind: "err",
        code: "PayloadTooLarge",
        status: 413,
        message: `Body exceeds ${maxBytes} bytes`,
      };
    }
    raw = new TextDecoder().decode(buffer);
  } catch (e) {
    if (e instanceof BaerlyError && e.code === "PayloadTooLarge") {
      return { kind: "err", code: "PayloadTooLarge", status: 413, message: e.message };
    }
    return {
      kind: "err",
      code: "SchemaError",
      status: 400,
      message: `Failed to read request body: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (raw.length === 0) {
    return { kind: "err", code: "SchemaError", status: 400, message: "Empty request body" };
  }
  try {
    return { kind: "ok", value: JSON.parse(raw) };
  } catch {
    return {
      kind: "err",
      code: "SchemaError",
      status: 400,
      message: "Invalid JSON in request body",
    };
  }
}
