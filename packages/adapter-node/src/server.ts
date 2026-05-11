import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import type { Storage } from "@baerly/protocol";
import { NODE_PROFILE, runScheduledMaintenance } from "@baerly/server";

/**
 * Options for {@link createListener}. The triple
 * `(app, tenant, storage)` matches what the `Db.create` factory
 * accepts in `@baerly/server`.
 *
 * - `app` — bucket-prefix for this baerly app (one bucket per app;
 *   ADR-0006).
 * - `tenant` — tenant prefix within the app's bucket. Production
 *   will derive this from a `Verifier` + the request's credentials;
 *   for Phase 3 the listener is single-tenant and `tenant` pins it.
 * - `storage` — any `Storage` impl. Production uses `S3HttpStorage`;
 *   dev workflows use `LocalFsStorage`.
 */
export interface CreateListenerOptions {
  readonly app: string;
  readonly tenant: string;
  readonly storage: Storage;
}

/**
 * Build a `node:http`-compatible {@link RequestListener} that wraps
 * the (future) `Db` + `ServerWriter` runtime.
 *
 * The factory returns a {@link RequestListener} (`(req, res) => void`),
 * not a pre-built `http.Server`. Callers own TLS termination, port
 * binding, keep-alive tuning, graceful shutdown, and cluster wiring:
 *
 * ```ts
 * const listener = createListener({ app, tenant, storage });
 * http.createServer(listener).listen(PORT);
 * ```
 *
 * The shape mirrors the Cloudflare adapter's `fetch(req, env, ctx)`
 * — both are functions composed into the host's request lifecycle.
 *
 * Phase 3 surface:
 * - `GET /v1/healthz` → `200 {"ok":true}` (Content-Type
 *   `application/json`).
 * - Any other `/v1/*` → `501` with the `HttpErrorEnvelope` shape from
 *   `@baerly/server`'s contract:
 *   `{ "error": { "code": "Internal", "message": "Not implemented" } }`.
 *   `Internal` is used because `MPS3ErrorCode` has no
 *   `"NotImplemented"` variant today; the envelope stays valid
 *   against the Phase 6 schema.
 * - Anything not under `/v1/` → `404` (same envelope shape).
 *
 * Thrown errors become `500` with the same envelope. The listener
 * never re-throws — an unhandled exception would otherwise crash
 * Node's `http.Server` via its `'error'` event.
 */
export function createListener(opts: CreateListenerOptions): RequestListener {
  // Captured for the forthcoming Db + ServerWriter wiring; not read
  // in Phase 3. Touching each once keeps `noUnusedLocals` quiet.
  void opts.app;
  void opts.tenant;
  void opts.storage;

  return (req: IncomingMessage, res: ServerResponse) => {
    // Fire-and-forget from Node's perspective; `handle` awaits
    // internally and never re-throws. Standard pattern for an async
    // `node:http` listener.
    void handle(req, res);
  };
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = req.url ?? "/";
  const path = url.split("?", 1)[0]!;

  try {
    if (req.method === "GET" && path === "/v1/healthz") {
      writeJson(res, 200, { ok: true });
      return;
    }
    if (path.startsWith("/v1/")) {
      writeError(res, 501, "Internal", "Not implemented");
      return;
    }
    writeError(res, 404, "Internal", `No route for ${req.method ?? "?"} ${path}`);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    writeError(res, 500, "Internal", message);
  }
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  // `Buffer.byteLength` (not `payload.length`) — multi-byte UTF-8
  // characters count for more than one byte each. `String.length`
  // would undercount and truncate the response mid-character.
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(Buffer.byteLength(payload)),
  });
  res.end(payload);
}

function writeError(res: ServerResponse, status: number, code: string, message: string): void {
  // `HttpErrorEnvelope` is constructed inline rather than imported
  // from `@baerly/server` — it's two JSON-literal fields. When the
  // server package ships a runtime builder, swap to it.
  writeJson(res, status, { error: { code, message } });
}

/**
 * Options for {@link runMaintenanceTick}.
 */
export interface NodeMaintenanceOptions {
  /** Any {@link Storage} impl — `S3HttpStorage`, `LocalFsStorage`, etc. */
  readonly storage: Storage;
  /** Full bucket-relative key of the CAS pointer for the target collection. */
  readonly currentJsonKey: string;
  /** Forwarded to both `compact()` and `runGc()` underneath. */
  readonly signal?: AbortSignal;
}

/**
 * Run one pass of compaction + GC for one collection. Node hosts have
 * no subrequest cap, so the {@link NODE_PROFILE} lets a single pass
 * fold the entire live tail and sweep up to 1000 candidates per run.
 *
 * Pair with `node-cron`, systemd timers, or k8s CronJobs — this
 * function is a single-shot callable that does not loop. Errors
 * propagate; the caller decides retry semantics.
 *
 * `compact()` and `runGc()` are each CAS-protected single-attempts:
 * a crash or restart between phases is safe because the next tick
 * picks up where the previous one left off.
 *
 * @example
 * ```ts
 * import cron from "node-cron";
 * import { runMaintenanceTick } from "@baerly/adapter-node";
 *
 * cron.schedule("0 * * * *", async () => {  // hourly
 *   await runMaintenanceTick({ storage, currentJsonKey: "..." });
 * });
 * ```
 */
export const runMaintenanceTick = async (opts: NodeMaintenanceOptions): Promise<void> => {
  await runScheduledMaintenance(
    { storage: opts.storage, currentJsonKey: opts.currentJsonKey },
    {
      ...NODE_PROFILE,
      ...(opts.signal !== undefined && { signal: opts.signal }),
    },
  );
};
