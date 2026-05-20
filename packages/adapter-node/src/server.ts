import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import {
  extname,
  relative as relativePath,
  resolve as resolvePath,
  sep as pathSep,
} from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import {
  BaerlyError,
  type MetricsRecorder,
  type Storage,
  type Verifier,
  noopMetricsRecorder,
} from "@baerly/protocol";
import { type DevLandingOptions, renderDevLanding } from "@baerly/dev";
import { type BaerlyConfig, Db, collectionsToMaps } from "@baerly/server";
import { MAX_BODY_BYTES, createRouter, mapError } from "@baerly/server/http";
import { runScheduledMaintenance } from "@baerly/server/maintenance";
import { prettyConsoleSink } from "./logger-pretty.ts";
import {
  type ObservabilityConfig,
  alsAwareRecorder,
  configureObservability,
  createObservabilityContext,
  decideSample,
  deriveOutcome,
  flushCanonicalLine,
  flushUnauthorizedAndRespond,
  getEffectiveSampleRate,
  observableStorage,
  runWithContext,
} from "@baerly/server/observability";

/**
 * Options for {@link createListener}.
 *
 * - `app` — bucket-prefix for this baerly app (one bucket per app).
 * - `storage` — any `Storage` impl. Production uses `S3HttpStorage`;
 *   dev workflows use `LocalFsStorage`.
 * - `verifier` — auth seam. Called on every `/v1/t/*` request; the
 *   returned `tenantPrefix` pins the per-request `Db`. On `null`,
 *   the listener short-circuits with 401. `GET /v1/healthz` bypasses
 *   the verifier so readiness probes don't need an auth token.
 * - `metrics` — operator's long-term {@link MetricsRecorder}.
 *   Receives every kernel emission (Writer histograms,
 *   CAS-conflict counters, storage per-call counts) verbatim.
 *   Defaults to {@link noopMetricsRecorder}.
 * - `observability` — LogTape config (level/sink/sampleRate)
 *   with `LOG_LEVEL` / `LOG_SAMPLE` envvar fallbacks. When the field
 *   is unset, the default sink is auto-selected: the local
 *   `prettyConsoleSink()` when `process.stdout.isTTY === true`
 *   (developer terminals), `"console-json"` otherwise (production
 *   hosts where stdout is piped to a log aggregator). The typed
 *   `sink` field always wins.
 *   Pass `{}` to opt into TTY auto-detection at default level/rate.
 *   Pass `undefined` (the field's absence) to skip
 *   `configureObservability` entirely.
 * - `webRoot` — optional static-asset directory. When set, requests
 *   that miss `/v1/*` and the dev landing-page short-circuits are
 *   served from disk, with `index.html` as the SPA fallback for HTML
 *   navigation. Absent → behaviour is identical to today (non-`/v1/*`
 *   requests fall through to the kernel's 404 envelope).
 */
export interface CreateListenerOptions {
  readonly app: string;
  readonly storage: Storage;
  readonly verifier: Verifier;
  /**
   * Your `baerly.config.ts`. When set, the adapter flattens
   * `collections[*].schema` and `collections[*].indexes` into the
   * per-collection maps that {@link Db.create} consumes — so
   * server-side schema validation fires on commits and the auto-
   * planner sees declared indexes. Without this option, declared
   * collections have no effect on the `/v1/t/*` surface.
   *
   * Only `collections` is read — deploy-time fields (`target`,
   * `domain`, `requiredSecrets`, …) are ignored here.
   */
  readonly config?: BaerlyConfig;
  readonly metrics?: MetricsRecorder;
  readonly observability?: ObservabilityConfig;
  /**
   * Opt-in dev affordance. When set, the listener serves `GET /`
   * with a human-readable HTML page that links to {@link DevLandingOptions.uiUrl}
   * and `GET /favicon.ico` with 204 No Content. Leave unset in
   * production — most operators don't want a landing page on the
   * API root, and either path falls through to the existing 404
   * envelope when the option is absent.
   */
  readonly dev?: DevLandingOptions;
  /** Override the long-poll budget. Forwarded to `createRouter`. */
  readonly sinceTimeoutMs?: number;
  /** Override the long-poll inner-poll cadence. Forwarded to `createRouter`. */
  readonly sincePollIntervalMs?: number;
  /**
   * Optional static-asset root. When set, the listener serves files
   * from this directory for any request that:
   *   - is not `/v1/*` (API surface),
   *   - is not `GET /v1/healthz` (anonymous probe),
   *   - is not handled by the opt-in dev landing-page short-circuit.
   *
   * HTML navigation (`Accept: text/html`) that misses an on-disk file
   * falls back to `<webRoot>/index.html` to support SPA client-side
   * routing. Non-HTML misses return the standard 404 envelope.
   *
   * Path resolution rejects `..` segments and absolute paths so the
   * handler can't escape `webRoot`. Implementation uses `node:fs` +
   * `node:path` builtins; no new dependency lands.
   */
  readonly webRoot?: string;
}

/**
 * Build a `node:http`-compatible {@link RequestListener} that serves
 * the CRUD surface.
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
 * CRUD surface:
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
 * import { createListener, S3HttpStorage } from "baerly-storage/node";
 * import type { Verifier } from "baerly-storage";
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
  // Build the Fetch handler once. The factory owns observability
  // wiring, the metrics tee, and storage wrapping — createListener
  // is now purely the node:http adapter shell.
  const fetchHandler = createFetchHandler({
    app: opts.app,
    storage: opts.storage,
    verifier: opts.verifier,
    ...(opts.config !== undefined && { config: opts.config }),
    ...(opts.metrics !== undefined && { metrics: opts.metrics }),
    ...(opts.observability !== undefined && { observability: opts.observability }),
    ...(opts.sinceTimeoutMs !== undefined && { sinceTimeoutMs: opts.sinceTimeoutMs }),
    ...(opts.sincePollIntervalMs !== undefined && {
      sincePollIntervalMs: opts.sincePollIntervalMs,
    }),
  });

  return (req: IncomingMessage, res: ServerResponse) => {
    // Fire-and-forget from Node's perspective; `handle` awaits
    // internally and never re-throws. Standard pattern for an async
    // node:http listener.
    void handle(req, res, opts, fetchHandler);
  };
}

/**
 * Options for {@link createFetchHandler}.
 *
 * Identical to {@link CreateListenerOptions} minus the Node-fs-specific
 * fields (`webRoot`, `dev`). Use this when mounting the baerly `/v1/*`
 * cascade under a Fetch-style host (Hono, Express, h3); use
 * {@link createListener} when binding directly to `node:http`, or
 * {@link baerlyNode} for the one-call host helper.
 */
export interface CreateFetchHandlerOptions {
  readonly app: string;
  readonly storage: Storage;
  readonly verifier: Verifier;
  /** See {@link CreateListenerOptions.config}. */
  readonly config?: BaerlyConfig;
  readonly metrics?: MetricsRecorder;
  readonly observability?: ObservabilityConfig;
  readonly sinceTimeoutMs?: number;
  readonly sincePollIntervalMs?: number;
}

/**
 * Build a `(req: Request) => Promise<Response>` handler that runs the
 * baerly `/v1/*` cascade: healthz short-circuit → observability context
 * → verifier → `Db.create` → `createRouter({db}).fetch(req)` →
 * canonical-line flush. The handler is host-agnostic; mount it under
 * `/v1/*` in your Fetch framework.
 *
 * Non-`/v1/*` paths fall through to the Hono router, which renders the
 * kernel's 404 envelope. To compose static-asset or dev-landing
 * handlers, dispatch those upstream of this factory.
 *
 * @example
 * ```ts
 * import { Hono } from "hono";
 * import { createFetchHandler, s3Storage } from "baerly-storage/node";
 *
 * const baerly = createFetchHandler({
 *   app: "tickets",
 *   storage: s3Storage({ ... }),
 *   verifier,
 * });
 * const app = new Hono();
 * app.all("/v1/*", (c) => baerly(c.req.raw));
 * ```
 */
export function createFetchHandler(
  opts: CreateFetchHandlerOptions,
): (req: Request) => Promise<Response> {
  // Factory-time, idempotent. Mirrors the wiring previously inside
  // createListener (which will delegate here in a follow-up commit).
  void configureObservability(resolveDefaultSink(opts.observability ?? {}));
  const operatorRecorder = opts.metrics ?? noopMetricsRecorder;
  const teeRecorder = alsAwareRecorder(operatorRecorder);
  const wrappedStorage = observableStorage(opts.storage, teeRecorder);
  // Flatten declared collections once at factory time. Maps are
  // frozen-empty sentinels when `config` is unset, so per-request
  // `Db.create` is allocation-free either way.
  const { schemas, indexes } = collectionsToMaps(opts.config?.collections);

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const path = url.pathname;

    // /v1/healthz is anonymous; the deploy-probe contract bypasses
    // verifier AND observability so probes don't flood logs. Matches
    // adapter-cloudflare/src/worker.ts.
    if (request.method === "GET" && path === "/v1/healthz") {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
    const sampleRate = getEffectiveSampleRate();
    const obsCtx = createObservabilityContext({
      request_id: requestId,
      sampled_by_head: decideSample(requestId, sampleRate),
    });

    const result = await opts.verifier(request);
    if (result === null) {
      return await runWithContext(obsCtx, async () => flushUnauthorizedAndRespond(obsCtx, request));
    }

    return await runWithContext(obsCtx, async () => {
      let outboundStatus = 500;
      let caughtError: unknown;
      let response: Response;
      try {
        const db = Db.create({
          storage: wrappedStorage,
          app: opts.app,
          tenant: result.tenantPrefix,
          metrics: teeRecorder,
          schemas,
          indexes,
        });
        const router = createRouter({
          db,
          ...(opts.sinceTimeoutMs !== undefined && { sinceTimeoutMs: opts.sinceTimeoutMs }),
          ...(opts.sincePollIntervalMs !== undefined && {
            sincePollIntervalMs: opts.sincePollIntervalMs,
          }),
        });
        response = await router.fetch(request);
        outboundStatus = response.status;
      } catch (error) {
        caughtError = error;
        const { status, envelope } = mapError(error);
        outboundStatus = status;
        response = new Response(JSON.stringify(envelope), {
          status,
          headers: { "content-type": "application/json" },
        });
      } finally {
        flushCanonicalLine(obsCtx, obsCtx.recorder, {
          unit: "http",
          status: outboundStatus,
          outcome: deriveOutcome(request.method, outboundStatus, caughtError),
          ...(caughtError !== undefined && { error: caughtError }),
          extra: { method: request.method, path },
        });
      }
      return response;
    });
  };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  opts: CreateListenerOptions,
  fetchHandler: (request: Request) => Promise<Response>,
): Promise<void> {
  const path = (req.url ?? "/").split("?", 1)[0]!;

  // Opt-in dev landing page (Node-only — returns HTML, isn't part
  // of the /v1/* surface). Short-circuits BEFORE observability so
  // it doesn't flood logs.
  if (opts.dev !== undefined && req.method === "GET") {
    if (path === "/") {
      writeHtml(res, 200, renderDevLanding(opts.dev));
      return;
    }
    if (path === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }
  }

  // Static-asset branch (Node-fs-specific). Runs only when the
  // caller opted into a `webRoot`, for GET/HEAD requests that
  // don't target the API surface. Bypasses verifier + observability
  // exactly as before.
  if (
    opts.webRoot !== undefined &&
    (req.method === "GET" || req.method === "HEAD") &&
    !path.startsWith("/v1/")
  ) {
    const served = await serveStaticAsset(req, res, path, opts.webRoot);
    if (served) {
      return;
    }
  }

  // Everything else: convert IncomingMessage → Request, delegate
  // to the Fetch handler, pipeline the Response body back to res.
  // The hand-rolled IncomingMessage → ReadableStream conversion in
  // `toFetchRequest` / `readNodeStream` stays — it enforces the
  // MAX_BODY_BYTES cap with drain-after-exceed semantics that
  // Readable.toWeb() doesn't preserve.
  //
  // Propagate client-disconnect to the kernel so long-polls (/v1/since)
  // and any other AbortSignal-aware handler short-circuit instead of
  // burning storage ops on a dead socket. `res` emits 'close' for both
  // clean and unclean teardown; `writableEnded` distinguishes them
  // (true == we finished, false == client gave up first), so we only
  // abort in the disconnect case.
  const controller = new AbortController();
  res.once("close", () => {
    if (!res.writableEnded) {
      controller.abort();
    }
  });

  const request = toFetchRequest(req, controller.signal);
  let response: Response;
  try {
    response = await fetchHandler(request);
  } catch (error) {
    // createFetchHandler swallows kernel errors via `mapError`. An
    // exception here is an unexpected adapter-side fault. Surface
    // the envelope so node:http doesn't emit an 'error' event and
    // crash the server.
    const { status, envelope } = mapError(error);
    if (!res.destroyed) {
      writeJson(res, status, envelope);
    }
    return;
  }

  // Client disconnected before the handler resolved — `setHeader` on
  // a destroyed `res` would throw, and pumping bytes is pointless.
  if (res.destroyed) {
    return;
  }

  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  if (response.body === null) {
    res.end();
    return;
  }
  // Response.body is the global WHATWG ReadableStream; Readable.fromWeb
  // wants node:stream/web's ReadableStream. They're structurally
  // identical at runtime; the cast bridges the type-only difference.
  //
  // `pipeline()` rejects with ERR_STREAM_UNABLE_TO_PIPE /
  // ERR_STREAM_PREMATURE_CLOSE / ECONNRESET when the client closes the
  // socket mid-stream (regression from commit 5dbe193 — the previous
  // manual reader loop tolerated this; pipeline does not). Headers are
  // already on the wire — there's no recovery — so swallow the
  // disconnect codes. Genuine stream errors still propagate.
  try {
    await pipeline(
      Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>),
      res,
    );
  } catch (error) {
    if (!isClientDisconnect(error)) {
      throw error;
    }
  }
}

function isClientDisconnect(err: unknown): boolean {
  if (err === null || typeof err !== "object") {
    return false;
  }
  const code = (err as { code?: unknown }).code;
  return (
    code === "ERR_STREAM_UNABLE_TO_PIPE" ||
    code === "ERR_STREAM_PREMATURE_CLOSE" ||
    code === "ERR_STREAM_DESTROYED" ||
    code === "ERR_STREAM_WRITE_AFTER_END" ||
    code === "ECONNRESET" ||
    code === "EPIPE"
  );
}

/**
 * Convert an `IncomingMessage` into a WHATWG `Request`. Node 24+
 * has `globalThis.Request` natively. The host portion is a
 * placeholder since Hono only inspects path + query.
 *
 * `signal` is attached to the synthesized `Request` so AbortSignal-aware
 * handlers (notably `/v1/since` long-poll) see client disconnects.
 */
function toFetchRequest(req: IncomingMessage, signal: AbortSignal): Request {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) {
      continue;
    }
    headers.set(k, Array.isArray(v) ? v.join(", ") : v);
  }
  const init: RequestInit = { method: req.method, headers, signal };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = readNodeStream(req, MAX_BODY_BYTES);
    // `duplex: "half"` is mandatory in Node 24+ when `body` is a
    // ReadableStream; `RequestInit` doesn't yet type it.
    (init as RequestInit & { duplex?: "half" }).duplex = "half";
  }
  return new Request(url.toString(), init);
}

/**
 * Pump `IncomingMessage` bytes into a WHATWG `ReadableStream`,
 * enforcing the `maxBytes` cap mid-stream. When the running total
 * crosses the cap we fail the stream with a
 * `BaerlyError{code:"PayloadTooLarge"}` so the router's
 * `arrayBuffer()` call rejects; the router's `readJsonBody`
 * recognises the `BaerlyError` and surfaces 413 PayloadTooLarge on
 * the wire.
 *
 * After the cap trips we keep draining the socket — silently
 * discarding subsequent chunks — rather than `req.destroy()`-ing it.
 * Destroying tears down the shared `req`/`res` TCP socket before
 * the 413 envelope can be flushed and surfaces as a client-side
 * "socket hang up" instead of a clean 413 (verified against
 * Node's `fetch()`, which won't read the response until its
 * outbound body write completes). Draining preserves the OOM
 * protection — we stop enqueueing past the cap, so memory is
 * bounded by `maxBytes` regardless of how much the attacker sends
 * — while letting the client finish its upload and then read the
 * 413 we already queued.
 *
 * Without this cap a chunked / Content-Length-absent request could
 * buffer arbitrarily many bytes before the router's post-
 * materialise length check fires. Workers don't need this guard
 * because the platform pre-caps the body (16 MB free / 100 MB paid).
 */
function readNodeStream(req: IncomingMessage, maxBytes: number): ReadableStream<Uint8Array> {
  let total = 0;
  let exceeded = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      req.on("data", (chunk: Buffer) => {
        if (exceeded) {
          return;
        }
        total += chunk.byteLength;
        if (total > maxBytes) {
          exceeded = true;
          controller.error(new BaerlyError("PayloadTooLarge", `Body exceeds ${maxBytes} bytes`));
          // No destroy/pause: drain remaining bytes into the void
          // so the client can finish writing and read our 413.
          return;
        }
        controller.enqueue(new Uint8Array(chunk));
      });
      req.on("end", () => {
        if (!exceeded) {
          controller.close();
        }
      });
      req.on("error", (err) => {
        if (!exceeded) {
          controller.error(err);
        }
      });
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

function writeHtml(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": String(Buffer.byteLength(body)),
  });
  res.end(body);
}

/**
 * Map a file extension to its `Content-Type`. The set is deliberately
 * small — every entry corresponds to something Vite or a typical SPA
 * pipeline actually emits. Unknown extensions fall back to
 * `application/octet-stream`, which keeps the browser from sniffing
 * untrusted bytes as HTML.
 */
const MIME_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

/**
 * Resolve a request path under `webRoot` without allowing `..` escape
 * or absolute-segment hijacking. Returns the resolved absolute path on
 * success, or `null` when the request should fall through (traversal
 * attempt, NUL byte, malformed URL encoding).
 */
function resolveUnderWebRoot(reqPath: string, webRoot: string): string | null {
  // The healthz / dev short-circuits already ran above, so `reqPath`
  // is always a `/`-rooted path; we work in POSIX form regardless of
  // host OS.
  let relative = reqPath;
  if (relative === "" || relative === "/") {
    relative = "/index.html";
  } else if (relative.endsWith("/")) {
    relative = `${relative}index.html`;
  }

  // Reject NUL bytes immediately — no filesystem call should ever see
  // one.
  if (relative.includes("\0")) {
    return null;
  }

  // Walk the segments, URL-decoding each one in isolation. Decoding
  // the whole path string would let `%2F` (`/`) sneak through as a
  // segment separator that bypasses the per-segment `..` check.
  const segments: string[] = [];
  for (const raw of relative.split("/")) {
    if (raw === "") {
      continue;
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (decoded === "" || decoded === ".") {
      continue;
    }
    if (decoded === "..") {
      return null;
    }
    if (decoded.includes("\0")) {
      return null;
    }
    if (decoded.includes("/") || decoded.includes("\\")) {
      return null;
    }
    segments.push(decoded);
  }

  const resolved = resolvePath(webRoot, ...segments);
  const rel = relativePath(webRoot, resolved);
  // `path.relative` returns `""` when `resolved === webRoot` (the
  // directory itself) and a `..`-prefixed path when `resolved` escapes
  // `webRoot`. Both are rejected.
  if (rel === "" || rel.startsWith("..") || rel.startsWith(`..${pathSep}`)) {
    return null;
  }
  return resolved;
}

/**
 * Determine whether the request should fall back to `index.html` on a
 * filesystem miss. Browsers send `Accept: text/html,...` for SPA
 * navigations; programmatic `fetch()` calls for missing JSON / image
 * assets do not, and they get the kernel's 404 envelope instead.
 */
function wantsHtmlFallback(req: IncomingMessage): boolean {
  const accept = req.headers.accept;
  if (typeof accept !== "string") {
    return false;
  }
  return accept.includes("text/html");
}

/**
 * `fs.stat` that returns `null` for the missing-file cases that this
 * handler treats as a fall-through (ENOENT / ENOTDIR / non-file).
 * Other errors (EACCES, EIO, ...) propagate.
 */
async function statFile(target: string): Promise<Awaited<ReturnType<typeof stat>> | null> {
  try {
    const stats = await stat(target);
    return stats.isFile() ? stats : null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return null;
    }
    throw error;
  }
}

/**
 * Serve a single file under `webRoot` for a GET/HEAD request.
 *
 * Returns `true` once the response has been written. Returns `false`
 * when the caller should fall through to the verifier-mounted router
 * (path traversal rejected, file not found and no SPA fallback, etc.).
 */
async function serveStaticAsset(
  req: IncomingMessage,
  res: ServerResponse,
  reqPath: string,
  webRoot: string,
): Promise<boolean> {
  const resolved = resolveUnderWebRoot(reqPath, webRoot);
  if (resolved === null) {
    return false;
  }

  // Try the resolved path first. A miss (ENOENT/ENOTDIR or non-file)
  // can fall through to `<webRoot>/index.html` for HTML navigation so
  // SPAs can own client-side routing.
  const primary = await statFile(resolved);
  let target = resolved;
  let stats = primary;
  if (stats === null) {
    if (!wantsHtmlFallback(req)) {
      return false;
    }
    const indexPath = resolvePath(webRoot, "index.html");
    const fallback = await statFile(indexPath);
    if (fallback === null) {
      return false;
    }
    target = indexPath;
    stats = fallback;
  }

  const ext = extname(target).toLowerCase();
  const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
  // Vite emits long-lived hashed bundles under `assets/`; everything
  // else (including `index.html`, which is fetched on every nav) wants
  // a fresh copy.
  const relForCache = relativePath(webRoot, target).split(pathSep).join("/");
  const cacheControl =
    relForCache.startsWith("assets/") && target !== resolvePath(webRoot, "index.html")
      ? "public, max-age=3600"
      : "no-cache";

  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": String(stats.size),
    "Cache-Control": cacheControl,
  });

  if (req.method === "HEAD") {
    res.end();
    return true;
  }

  await pipeline(createReadStream(target), res);
  return true;
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
  /**
   * Operator's long-term {@link MetricsRecorder}. Defaults to
   * {@link noopMetricsRecorder}. Receives every compactor + GC
   * emission verbatim alongside the canonical-line bag
   * created by `withObservability("maintenance", ...)` inside
   * `runScheduledMaintenance`.
   */
  readonly metrics?: MetricsRecorder;
}

/**
 * Run one pass of compaction + GC for one collection. Node hosts have
 * no subrequest cap, so this uses the engine defaults (unbounded) —
 * a single pass folds the entire live tail and sweeps every aged-out
 * candidate.
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
 * import { runMaintenanceTick } from "baerly-storage/node";
 *
 * cron.schedule("0 * * * *", async () => {  // hourly
 *   await runMaintenanceTick({ storage, currentJsonKey: "..." });
 * });
 * ```
 */
export const runMaintenanceTick = async (opts: NodeMaintenanceOptions): Promise<void> => {
  // `teeRecorder` (ALS-aware) wraps the storage observer so storage
  // metrics land in the operator's sink AND the active per-scope bag
  // via ALS. `metrics:` to maintenance is the bare `operatorRecorder`
  // — `runScheduledMaintenance`'s own `withObservability` opens the
  // scope, and `compactInner` / `runGcInner` already tee operator
  // with the scope's per-run recorder for canonical-line fill.
  // Passing the ALS-aware wrapper here would double-write the bag.
  const operatorRecorder = opts.metrics ?? noopMetricsRecorder;
  const teeRecorder = alsAwareRecorder(operatorRecorder);
  await runScheduledMaintenance(
    {
      storage: observableStorage(opts.storage, teeRecorder),
      currentJsonKey: opts.currentJsonKey,
    },
    {
      ...(opts.signal !== undefined && { signal: opts.signal }),
      metrics: operatorRecorder,
    },
  );
};

/**
 * Auto-pick the default sink when the caller passed an
 * {@link ObservabilityConfig} without a `sink` field. On a TTY
 * (developer terminals) we prefer pretty output; otherwise JSON
 * (production hosts pipe stdout to a log aggregator).
 *
 * Returns a new config with `sink` defaulted; if the caller already
 * supplied a `sink` (function or shorthand string) we pass the
 * config through verbatim. Either way the caller's `level` and
 * `sampleRate` (when set) reach LogTape unchanged.
 *
 * Exported for the test suite — the TTY check is otherwise a pure
 * read of `process.stdout.isTTY` and a default lookup, neither
 * worth a black-box round-trip.
 */
export const resolveDefaultSink = (config: ObservabilityConfig): ObservabilityConfig => {
  if (config.sink !== undefined) {
    return config;
  }
  // `process.stdout.isTTY` is `true` only on real terminals. CI
  // pipelines, docker logs, systemd, and pm2 cluster mode all
  // pipe stdout — `isTTY` is `undefined` (falsy) there. The kernel
  // only ships `"console-json"`; we construct the pretty sink
  // locally and pass it as a function so picocolors stays off the
  // kernel closure.
  const isTty = Boolean(process.stdout.isTTY);
  return { ...config, sink: isTty ? prettyConsoleSink() : "console-json" };
};
