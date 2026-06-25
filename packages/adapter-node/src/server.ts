import {
  type BaerlyConfig,
  MAINTENANCE_PROFILE_NODE,
  type Storage,
  type Verifier,
} from "@baerly/protocol";
import { Db } from "@baerly/server";
import { createRouter, mapError } from "@baerly/server/http";
import { handleSpecRequest } from "@baerly/server/spec";
import type { MaintenanceDispatch } from "@baerly/server/maintenance";
import { prettyConsoleSink } from "./logger-pretty.ts";
import {
  type ObservabilityConfig,
  configureObservability,
  createObservabilityContext,
  deriveOutcome,
  flushCanonicalLine,
  flushUnauthorizedAndRespond,
  observableStorage,
  runWithContext,
} from "@baerly/server/observability";

/**
 * Options for {@link createFetchHandler}.
 *
 * Host-agnostic Fetch-shaped cascade entry point. The Node-host-specific
 * options (`webRoot`, `dev`) live on {@link CreateAppOptions} so they
 * only reach the middleware stack that consumes them.
 *
 * @internal — public consumers see {@link CreateAppOptions} from
 * `./app.ts` instead. Exported for intra-package re-use.
 */
export interface CreateFetchHandlerOptions {
  readonly app: string;
  readonly storage: Storage;
  readonly verifier: Verifier;
  /**
   * Your `baerly.config.ts`. When set, the adapter forwards it to
   * {@link Db.create} on every request — so server-side schema
   * validation fires on commits and the auto-planner sees declared
   * indexes. Without this option, declared collections have no
   * effect on the `/v1/c/*` surface.
   *
   * Only `collections` is read — deploy-time fields (`target`,
   * `domain`, `requiredSecrets`, …) are ignored here.
   */
  readonly config?: BaerlyConfig;
  /**
   * LogTape config (level/sink) with `LOG_LEVEL` envvar fallback.
   * When the field is unset, the default sink is auto-selected: the
   * local `prettyConsoleSink()` when `process.stdout.isTTY === true`
   * (developer terminals), `"console-json"` otherwise (production
   * hosts where stdout is piped to a log aggregator). The typed
   * `sink` field always wins. Pass `{}` to opt into TTY
   * auto-detection at default level. Pass `undefined` (the field's
   * absence) to skip `configureObservability` entirely.
   */
  readonly observability?: ObservabilityConfig;
  /** Override the long-poll budget. Forwarded to `createRouter`. */
  readonly sinceTimeoutMs?: number;
  /** Override the long-poll inner-poll cadence. Forwarded to `createRouter`. */
  readonly sincePollIntervalMs?: number;
}

/**
 * Assemble the per-request {@link MaintenanceDispatch} for a Node host.
 *
 * baerly maintains IN-BAND: the writer reads
 * `getCurrentContext()?.maintenance` at its post-commit dispatch point and
 * runs one bounded compact + GC slice on the (rare) write that crosses a
 * maintenance trigger. Reads stay pure — they never tick. There is no
 * `setInterval`, no cron, no operator-installed scheduler: the kernel
 * maintains itself on a bare bucket with zero operator infrastructure.
 *
 * On Node v1 maintenance runs INLINE on the commit path (no
 * `dispatch` override — serverful Node has no `waitUntil`, and inline is
 * deterministic + correct here), so this returns no `dispatch` field;
 * the writer falls back to its inline-awaited default dispatch.
 *
 * The caps (`options`) are a MODERATE multiple of the CF-free defaults —
 * Node has no Cloudflare subrequest wall, but because v1 runs inline the
 * per-pass work is still BOUNDED by worst-case single-write added
 * latency, not unbounded. We thread `phasesPerTick: "both"` (a capable
 * host can fold AND GC in one tick) plus the Node-tier `WRITE_TICK_*`
 * overrides from `@baerly/protocol`'s `NODE_MAINTENANCE_*` constants
 * (10× CF-free, with a shorter GC interval so the sweep budget keeps up).
 *
 * The two ops-plane env vars are read here (per call) so a `vi.stubEnv`
 * in tests — and a real process env in production — is observed:
 *
 *   - `BAERLY_MAINTENANCE_MAX_FOLD_BYTES` → `maxFoldBytes` (the snapshot
 *     ceiling `C`). Parsed as a number; ignored when unset / NaN.
 *   - `BAERLY_MAINTENANCE_DISABLE` → `disabled` (kill switch). Truthy
 *     when set to a non-empty value other than `"0"` / `"false"`.
 *
 * `readEnv` defaults to `process.env`; the parameter exists for direct
 * unit coverage.
 */
export const nodeMaintenanceDispatch = (
  readEnv: (key: string) => string | undefined = (k) => process.env[k],
): MaintenanceDispatch => {
  const rawFoldBytes = readEnv("BAERLY_MAINTENANCE_MAX_FOLD_BYTES");
  const parsedFoldBytes =
    rawFoldBytes !== undefined && rawFoldBytes !== "" ? Number(rawFoldBytes) : Number.NaN;
  const maxFoldBytes = Number.isFinite(parsedFoldBytes) ? parsedFoldBytes : undefined;

  const rawDisable = readEnv("BAERLY_MAINTENANCE_DISABLE");
  const disabled =
    rawDisable !== undefined &&
    rawDisable !== "" &&
    rawDisable !== "0" &&
    rawDisable.toLowerCase() !== "false";

  return {
    // No `dispatch` override: inline on serverful Node (the writer
    // falls back to `dispatchInlineAwaited`).
    ...(disabled && { disabled: true }),
    ...(maxFoldBytes !== undefined && { maxFoldBytes }),
    options: {
      phasesPerTick: "both",
      profile: MAINTENANCE_PROFILE_NODE,
    },
  };
};

/**
 * Build a `(req: Request) => Promise<Response>` handler that runs the
 * baerly `/v1/*` cascade: healthz short-circuit → observability context
 * → verifier → `Db.create` → `createRouter({db}).fetch(req)` →
 * canonical-line flush. The handler is host-agnostic; mount it under
 * `/v1/*` in your Fetch framework.
 *
 * Non-`/v1/*` paths fall through to the Hono router, which renders the
 * kernel's 404 envelope. To compose static-asset or dev-landing
 * handlers, dispatch those upstream of this factory — see the
 * internal Hono-app factory in `./app.ts` for the production composition.
 *
 * @internal — public consumers reach this via `baerlyNode` from
 * `./baerly-node.ts`. Exported for intra-package re-use and direct unit
 * coverage in `server.test.ts`.
 */
export function createFetchHandler(
  opts: CreateFetchHandlerOptions,
): (req: Request) => Promise<Response> {
  // Factory-time, idempotent.
  void configureObservability(resolveDefaultSink(opts.observability ?? {}));
  const wrappedStorage = observableStorage(opts.storage);

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

    // /v1/spec is anonymous (like healthz): the static contract IR is
    // non-sensitive (same info as the public .d.ts). Per-tenant
    // collection names are appended ONLY when the verifier accepts —
    // we run it here tolerantly (null → anonymous, no 401), so an
    // unauthenticated probe still gets the static contract. Verifier
    // throws also degrade to anonymous: the static contract is public
    // and should stay available when the auth backend is unhealthy.
    if (request.method === "GET" && path === "/v1/spec") {
      return handleSpecRequest(request, async () => ({
        verifier: opts.verifier,
        config: opts.config,
      }));
    }

    const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
    // In-band maintenance: the writer reads `getCurrentContext()?.maintenance`
    // at its post-commit dispatch point. Read per request so the ops-plane env
    // vars (and any `vi.stubEnv` in tests) are observed at call time.
    const obsCtx = createObservabilityContext({
      request_id: requestId,
      maintenance: nodeMaintenanceDispatch(),
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
          config: opts.config,
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

/**
 * Auto-pick the default sink when the caller passed an
 * {@link ObservabilityConfig} without a `sink` field. On a TTY
 * (developer terminals) we prefer pretty output; otherwise JSON
 * (production hosts pipe stdout to a log aggregator).
 *
 * Returns a new config with `sink` defaulted; if the caller already
 * supplied a `sink` (function or shorthand string) we pass the
 * config through verbatim. Either way the caller's `level` (when
 * set) reaches LogTape unchanged.
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
