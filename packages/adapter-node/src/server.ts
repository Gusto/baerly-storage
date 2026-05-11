import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import type { Storage, Verifier } from "@baerly/protocol";
import { Db, NODE_PROFILE, createRouter, runScheduledMaintenance } from "@baerly/server";

/**
 * Options for {@link createListener}.
 *
 * - `app` — bucket-prefix for this baerly app (one bucket per app;
 *   ADR-0006).
 * - `storage` — any `Storage` impl. Production uses `S3HttpStorage`;
 *   dev workflows use `LocalFsStorage`.
 * - `verifier` — auth seam. Called on every `/v1/t/*` request; the
 *   returned `tenantPrefix` pins the per-request `Db`. On `null`,
 *   the listener short-circuits with 401. `GET /v1/healthz` bypasses
 *   the verifier so readiness probes don't need an auth token.
 */
export interface CreateListenerOptions {
  readonly app: string;
  readonly storage: Storage;
  readonly verifier: Verifier;
}

/**
 * Build a `node:http`-compatible {@link RequestListener} that serves
 * the Phase-6 CRUD surface.
 *
 * The factory returns a {@link RequestListener} (`(req, res) => void`),
 * not a pre-built `http.Server`. Callers own TLS termination, port
 * binding, keep-alive tuning, graceful shutdown, and cluster wiring:
 *
 * ```ts
 * const listener = createListener({ app, storage, verifier });
 * http.createServer(listener).listen(PORT);
 * ```
 *
 * The shape mirrors the Cloudflare adapter's `fetch(req, env, ctx)`
 * — both are functions composed into the host's request lifecycle.
 *
 * Phase 6 surface:
 * - `GET /v1/healthz` → `200 {"ok":true}` (anonymous; verifier
 *   bypassed).
 * - The five CRUD routes from `contract.ts` (`GET/POST/PATCH/DELETE
 *   /v1/t/:table[/:id]`) → `HttpOkEnvelope<T>` / `HttpErrorEnvelope`
 *   bodies under the status-code policy at `contract.ts:57-69`.
 * - Anything not under `/v1/` → `404` with the envelope shape.
 *
 * Thrown errors become `500` with the envelope. The listener never
 * re-throws — an unhandled exception would otherwise crash Node's
 * `http.Server` via its `'error'` event.
 *
 * @example
 * ```ts
 * import { createServer } from "node:http";
 * import { createListener, S3HttpStorage } from "@baerly/adapter-node";
 * import type { Verifier } from "@baerly/protocol";
 *
 * const verifier: Verifier = async (req) => {
 *   if (req.headers.get("authorization") !== "Bearer dev-token") return null;
 *   return { tenantPrefix: "acme", identity: { sub: "dev" } };
 * };
 *
 * const storage = new S3HttpStorage({ ... });
 * const listener = createListener({ app: "tickets", storage, verifier });
 * createServer(listener).listen(3000);
 * ```
 */
export function createListener(opts: CreateListenerOptions): RequestListener {
  return (req: IncomingMessage, res: ServerResponse) => {
    // Fire-and-forget from Node's perspective; `handle` awaits
    // internally and never re-throws. Standard pattern for an async
    // `node:http` listener.
    void handle(req, res, opts);
  };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  opts: CreateListenerOptions,
): Promise<void> {
  try {
    // /v1/healthz is anonymous; preserves the deploy-probe contract.
    const path = (req.url ?? "/").split("?", 1)[0]!;
    if (req.method === "GET" && path === "/v1/healthz") {
      writeJson(res, 200, { ok: true });
      return;
    }

    const request = toFetchRequest(req);
    const result = await opts.verifier(request);
    if (result === null) {
      writeError(res, 401, "Unauthorized", "Verifier returned null");
      return;
    }

    const db = Db.create({
      storage: opts.storage,
      app: opts.app,
      tenant: result.tenantPrefix,
    });
    const app = createRouter({ db, healthCheck: false });
    const response = await app.fetch(request);

    // Stream the Response body back through `res`.
    res.statusCode = response.status;
    response.headers.forEach((value, key) => res.setHeader(key, value));
    if (response.body === null) {
      res.end();
      return;
    }
    const reader = response.body.getReader();
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      res.write(chunk.value);
    }
    res.end();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    writeError(res, 500, "Internal", message);
  }
}

/**
 * Convert an `IncomingMessage` into a WHATWG `Request`. Node 24+
 * has `globalThis.Request` natively. The host portion is a
 * placeholder since Hono only inspects path + query.
 */
function toFetchRequest(req: IncomingMessage): Request {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    headers.set(k, Array.isArray(v) ? v.join(", ") : v);
  }
  const init: RequestInit = { method: req.method, headers };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = readNodeStream(req);
    // `duplex: "half"` is mandatory in Node 24+ when `body` is a
    // ReadableStream; `RequestInit` doesn't yet type it.
    (init as RequestInit & { duplex?: "half" }).duplex = "half";
  }
  return new Request(url.toString(), init);
}

function readNodeStream(req: IncomingMessage): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      req.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
      req.on("end", () => controller.close());
      req.on("error", (err) => controller.error(err));
    },
  });
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
