import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import {
  BaerlyError,
  type BaerlyErrorCode,
  type MetricsRecorder,
  type Storage,
  type Verifier,
  noopMetricsRecorder,
} from "@baerly/protocol";
import {
  Db,
  type DevLandingOptions,
  MAX_BODY_BYTES,
  createRouter,
  errorEnvelope,
  mapError,
  renderDevLanding,
} from "@baerly/server";
import { NODE_PROFILE, runScheduledMaintenance } from "@baerly/server/maintenance";
import {
  CATEGORY,
  type ObservabilityConfig,
  alsAwareRecorder,
  configureObservability,
  createObservabilityContext,
  decideSample,
  flushCanonicalLine,
  getEffectiveSampleRate,
  getLogger,
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
 *   Receives every kernel emission (ServerWriter histograms,
 *   CAS-conflict counters, storage per-call counts) verbatim.
 *   Defaults to {@link noopMetricsRecorder}.
 * - `observability` — LogTape config (level/sink/sampleRate)
 *   with `LOG_LEVEL` / `LOG_SAMPLE` envvar fallbacks. When the field
 *   is unset, the default sink is auto-selected: `"console-pretty"`
 *   when `process.stdout.isTTY === true` (developer terminals),
 *   `"console-json"` otherwise (production hosts where stdout is
 *   piped to a log aggregator). The typed `sink` field always wins.
 *   Pass `{}` to opt into TTY auto-detection at default level/rate.
 *   Pass `undefined` (the field's absence) to skip
 *   `configureObservability` entirely.
 */
export interface CreateListenerOptions {
  readonly app: string;
  readonly storage: Storage;
  readonly verifier: Verifier;
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
  // Observability wiring. Three pieces, all idempotent + non-blocking
  // on the request hot path:
  //
  // 1. `configureObservability` is called once at factory time.
  //    Node supports top-level `await`, but the factory is sync, so
  //    we kick off the configure asynchronously and let LogTape
  //    queue records emitted before configure resolves. LogTape's
  //    `configure` is idempotent (we always pass `reset: true`).
  //    Observability is always on: `resolveDefaultSink` picks the
  //    pretty sink on a TTY and JSON off-TTY so dev terminals and
  //    production log aggregators each get the right format without
  //    any caller-side configuration. To silence non-error lines,
  //    pass `observability: { sampleRate: 0 }` (head-sampling at 0
  //    drops all non-error lines; errors are still force-kept).
  //
  // 2. `alsAwareRecorder` wraps the operator's MetricsRecorder
  //    once. Every kernel emission lands in both the operator's
  //    sink and (when called from inside a `runWithContext` scope)
  //    the per-request bag. The wrapping is per-factory not
  //    per-request — the ALS lookup happens at call time.
  //
  // 3. `observableStorage` wraps the storage once at factory time
  //    (the storage handle is operator-owned and pinned per
  //    deployment, so per-request wrapping would just allocate a
  //    new closure for no behavior change).
  // Observability is always on. resolveDefaultSink picks console-pretty
  // on a TTY and console-json off-TTY; callers override either field
  // (level / sink / sampleRate) by passing opts.observability.
  void configureObservability(resolveDefaultSink(opts.observability ?? {}));
  const operatorRecorder = opts.metrics ?? noopMetricsRecorder;
  const teeRecorder = alsAwareRecorder(operatorRecorder);
  const wrappedStorage = observableStorage(opts.storage, teeRecorder);

  return (req: IncomingMessage, res: ServerResponse) => {
    // Fire-and-forget from Node's perspective; `handle` awaits
    // internally and never re-throws. Standard pattern for an async
    // `node:http` listener.
    void handle(req, res, opts, wrappedStorage, teeRecorder);
  };
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  opts: CreateListenerOptions,
  storage: Storage,
  teeRecorder: MetricsRecorder,
): Promise<void> {
  // /v1/healthz is anonymous; preserves the deploy-probe contract.
  const path = (req.url ?? "/").split("?", 1)[0]!;
  // Opt-in dev landing page. Off in production (opts.dev unset);
  // when set, GET / serves HTML and GET /favicon.ico answers 204 so
  // browsers don't pin a second JSON 404 next to the landing page.
  // These short-circuit BEFORE context creation — they don't
  // participate in observability.
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
  if (req.method === "GET" && path === "/v1/healthz") {
    writeJson(res, 200, { ok: true });
    return;
  }

  // Construct the per-request observability context up front so
  // EVERYTHING downstream — verifier rejection, `Db.create`, the
  // router dispatch, and the response streaming — runs inside the
  // same `runWithContext` scope.
  //
  // Context lifted into the adapter for cross-host symmetry with the
  // Cloudflare worker (which also lifts so its cache wrapper can
  // stamp `cache_status`). Node has no cache layer, so no
  // `cache_status` field is stamped here.
  //
  // The router's observability middleware (T01) detects the ambient
  // context and passes through — it never creates a competing context,
  // and it never flushes its own line. The adapter owns the flush.
  const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const requestId =
    (Array.isArray(req.headers["x-request-id"])
      ? req.headers["x-request-id"][0]
      : req.headers["x-request-id"]) ?? crypto.randomUUID();
  const sampleRate = getEffectiveSampleRate();
  const obsCtx = createObservabilityContext({
    request_id: requestId,
    sampled_by_head: decideSample(requestId, sampleRate),
  });

  const request = toFetchRequest(req);
  const result = await opts.verifier(request);
  if (result === null) {
    // Verifier rejection: wrap in runWithContext so the canonical
    // line still emits for 401 responses.
    await runWithContext(obsCtx, async () => {
      getLogger(CATEGORY.http).warn("verifier_rejected", { reason: "null" });
      writeError(res, 401, "Unauthorized", "Missing or invalid Authorization header");
      flushCanonicalLine(obsCtx, obsCtx.recorder, {
        unit: "http",
        status: 401,
        outcome: "error",
        extra: {
          method: req.method ?? "GET",
          path: requestUrl.pathname,
        },
      });
    });
    return;
  }

  // Db's `metrics: teeRecorder` carries the tee through to
  // ServerWriter / compactor / GC emissions so the canonical line
  // sees kernel-level histograms (class_a_ops_per_logical_write,
  // 412/429 counters) alongside the storage decorator's per-call
  // counts. Node has no cache layer so there is no cache_status
  // discriminator to stamp on the line.
  await runWithContext(obsCtx, async () => {
    let outboundStatus = 500;
    let caughtError: unknown;
    try {
      const db = Db.create({
        storage,
        app: opts.app,
        tenant: result.tenantPrefix,
        metrics: teeRecorder,
      });
      const app = createRouter({
        db,
        healthCheck: false,
        sinceTimeoutMs: opts.sinceTimeoutMs,
        sincePollIntervalMs: opts.sincePollIntervalMs,
      });
      const response = await app.fetch(request);
      outboundStatus = response.status;

      // Stream the Response body back through `res`.
      res.statusCode = response.status;
      response.headers.forEach((value, key) => res.setHeader(key, value));
      if (response.body === null) {
        res.end();
      } else {
        const reader = response.body.getReader();
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          res.write(chunk.value);
        }
        res.end();
      }
    } catch (err) {
      caughtError = err;
      // Route through `mapError` so the envelope shape and the 500-path
      // sanitization stay in lockstep with the Hono router.
      const { status, envelope } = mapError(err);
      outboundStatus = status;
      writeJson(res, status, envelope);
    } finally {
      flushCanonicalLine(obsCtx, obsCtx.recorder, {
        unit: "http",
        status: outboundStatus,
        outcome: deriveOutcome(req.method ?? "GET", outboundStatus, caughtError),
        ...(caughtError !== undefined && { error: caughtError }),
        extra: {
          method: req.method ?? "GET",
          path: requestUrl.pathname,
        },
      });
    }
  });
}

/**
 * Canonical-line outcome derivation for HTTP requests. Mirrors the
 * Cloudflare adapter's copy (see `packages/adapter-cloudflare/src/worker.ts`)
 * — duplicated here until a future ticket consolidates the helpers.
 * Both copies have the same shape:
 *
 *  - `status < 400`  → `"read"` for GETs, `"committed"` otherwise.
 *  - `status === 409` → `"conflict"` (writer CAS loss).
 *  - error path with `status >= 500` → `"error"`.
 *  - other 4xx/5xx → `"error"`.
 */
const deriveOutcome = (method: string, status: number, error?: unknown): string => {
  if (error !== undefined && status >= 500) return "error";
  if (status < 400) return method === "GET" ? "read" : "committed";
  if (status === 409) return "conflict";
  return "error";
};

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
        if (exceeded) return;
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
        if (!exceeded) controller.close();
      });
      req.on("error", (err) => {
        if (!exceeded) controller.error(err);
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

function writeError(
  res: ServerResponse,
  status: number,
  code: BaerlyErrorCode,
  message: string,
): void {
  writeJson(res, status, errorEnvelope(code, message));
}

function writeHtml(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": String(Buffer.byteLength(body)),
  });
  res.end(body);
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
  // Wrap the storage so the canonical line emitted by
  // `withObservability("maintenance", ...)` inside
  // `runScheduledMaintenance` sees per-call class A/B counts. The
  // `metrics:` forwarded to maintenance is the ALS-aware tee — when
  // a per-phase (compactor/gc) context is active, emissions land on
  // that nested bag; when only the outer maintenance context is
  // active, they land on the maintenance bag.
  const teeRecorder = alsAwareRecorder(opts.metrics ?? noopMetricsRecorder);
  await runScheduledMaintenance(
    {
      storage: observableStorage(opts.storage, teeRecorder),
      currentJsonKey: opts.currentJsonKey,
    },
    {
      ...NODE_PROFILE,
      ...(opts.signal !== undefined && { signal: opts.signal }),
      metrics: teeRecorder,
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
  if (config.sink !== undefined) return config;
  // `process.stdout.isTTY` is `true` only on real terminals. CI
  // pipelines, docker logs, systemd, and pm2 cluster mode all
  // pipe stdout — `isTTY` is `undefined` (falsy) there.
  const isTty = Boolean(process.stdout.isTTY);
  return { ...config, sink: isTty ? "console-pretty" : "console-json" };
};
