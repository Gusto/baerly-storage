/**
 * The deployed memory bench Worker: the real Cloudflare adapter
 * (`baerlyWorker`, R2 binding, in-band maintenance through `ctx.waitUntil`)
 * over a synthetic bucket, plus a few `/bench/*` routes that upload and
 * inspect fixtures. Every route needs `authorization: Bearer <BENCH_SECRET>`;
 * `/v1/*` takes its tenant from `x-bench-tenant`.
 *
 * Each request logs `PMBENCH {...}` lines: one when the response is ready
 * (R2 binding calls so far, cold flag, in-isolate wall time) and, when the
 * request dispatched `waitUntil` work, one after it settles (calls including
 * the write tick). Platform `outcome` / `cpuTime` come from `wrangler tail`.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { r2BindingStorage } from "@baerly/adapter-cloudflare";
import { type BaerlyEnv, baerlyWorker } from "@baerly/adapter-cloudflare/worker";
import type { BaerlyAppConfig, Verifier } from "@baerly/protocol";
import { APP, COLLECTION, tenantPrefix } from "../cells.ts";

interface BenchEnv extends BaerlyEnv {
  readonly BUCKET: R2Bucket;
  readonly BENCH_SECRET: string;
  readonly BENCH_EPOCH?: string;
}

interface Calls {
  get: number;
  put: number;
  delete: number;
  list: number;
}

const calls = new AsyncLocalStorage<Calls>();
let coldIsolate = true;

const count = (op: keyof Calls): void => {
  const c = calls.getStore();
  if (c !== undefined) {
    c[op] += 1;
  }
};

/** The binding with every call counted against the current request. */
const countingBucket = (bucket: R2Bucket): R2Bucket => {
  return {
    get: (...args: Parameters<R2Bucket["get"]>) => {
      count("get");
      return bucket.get(...args);
    },
    put: (...args: Parameters<R2Bucket["put"]>) => {
      count("put");
      return bucket.put(...args);
    },
    delete: (...args: Parameters<R2Bucket["delete"]>) => {
      count("delete");
      return bucket.delete(...args);
    },
    list: (...args: Parameters<R2Bucket["list"]>) => {
      count("list");
      return bucket.list(...args);
    },
  } as unknown as R2Bucket;
};

const config: BaerlyAppConfig = {
  app: APP,
  tenant: "unused",
  target: "cloudflare",
  auth: "none",
  collections: { [COLLECTION]: {} },
};

const authorized = (req: Request, env: BenchEnv): boolean =>
  typeof env.BENCH_SECRET === "string" &&
  env.BENCH_SECRET.length >= 32 &&
  req.headers.get("authorization") === `Bearer ${env.BENCH_SECRET}`;

const inner = baerlyWorker<BenchEnv>((env) => {
  const verifier: Verifier = async (req) => {
    const tenant = req.headers.get("x-bench-tenant");
    if (!authorized(req, env) || tenant === null || tenant === "" || tenant.includes("/")) {
      return null;
    }
    return { tenantPrefix: tenant, identity: null };
  };
  return { config, verifier, storage: r2BindingStorage(countingBucket(env.BUCKET)) };
});

const KEY_ROOT = `app/${APP}/tenant/`;
const assertBenchKey = (key: string | null): string => {
  if (key === null || !key.startsWith(KEY_ROOT) || key.includes("..")) {
    throw new Error(`key must start with ${KEY_ROOT}`);
  }
  return key;
};

/** The `/bench/*` fixture routes. Synthetic fixtures only. */
const benchRoute = async (req: Request, env: BenchEnv, url: URL): Promise<Response> => {
  const bucket = env.BUCKET;
  switch (`${req.method} ${url.pathname}`) {
    case "PUT /bench/object": {
      const key = assertBenchKey(url.searchParams.get("key"));
      const put = await bucket.put(key, req.body, {
        httpMetadata: { contentType: "application/json" },
      });
      return Response.json({ key, size: put?.size });
    }
    case "POST /bench/objects": {
      const objects = (await req.json()) as Record<string, string>;
      const entries = Object.entries(objects);
      for (let i = 0; i < entries.length; i += 50) {
        await Promise.all(
          entries.slice(i, i + 50).map(([key, text]) =>
            bucket.put(assertBenchKey(key), text, {
              httpMetadata: { contentType: "application/json" },
            }),
          ),
        );
      }
      return Response.json({ put: entries.length });
    }
    case "POST /bench/copy": {
      const from = assertBenchKey(url.searchParams.get("from"));
      const to = assertBenchKey(url.searchParams.get("to"));
      const src = await bucket.get(from);
      if (src === null) {
        return Response.json({ error: `missing ${from}` }, { status: 404 });
      }
      const put = await bucket.put(to, src.body, {
        httpMetadata: { contentType: "application/json" },
      });
      return Response.json({ to, size: put?.size });
    }
    case "POST /bench/delete": {
      const keys = ((await req.json()) as string[]).map((k) => assertBenchKey(k));
      if (keys.length > 0) {
        await bucket.delete(keys);
      }
      return Response.json({ deleted: keys.length });
    }
    case "GET /bench/head": {
      const tenant = url.searchParams.get("tenant") ?? "";
      const obj = await bucket.get(`${tenantPrefix(tenant)}manifests/${COLLECTION}/current.json`);
      return Response.json({ current: obj === null ? null : await obj.json() });
    }
    case "GET /bench/list": {
      const prefix = assertBenchKey(url.searchParams.get("prefix"));
      const cursor = url.searchParams.get("cursor") ?? undefined;
      const page = await bucket.list({ prefix, ...(cursor !== undefined && { cursor }) });
      return Response.json({
        keys: page.objects.map((o) => ({ key: o.key, size: o.size })),
        cursor: page.truncated ? page.cursor : null,
      });
    }
    case "POST /bench/wipe": {
      // Delete up to 5,000 objects under the bench root per request.
      let deleted = 0;
      let truncated = true;
      while (truncated && deleted < 5000) {
        const page = await bucket.list({ prefix: KEY_ROOT, limit: 1000 });
        if (page.objects.length > 0) {
          await bucket.delete(page.objects.map((o) => o.key));
        }
        deleted += page.objects.length;
        truncated = page.truncated;
      }
      return Response.json({ deleted, done: !truncated });
    }
    default: {
      return Response.json({ error: "unknown bench route" }, { status: 404 });
    }
  }
};

const log = (line: Record<string, unknown>): void => {
  console.log(`PMBENCH ${JSON.stringify(line)}`);
};

export default {
  async fetch(req: Request, env: BenchEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const cold = coldIsolate;
    coldIsolate = false;
    if (!authorized(req, env)) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    if (url.pathname.startsWith("/bench/")) {
      try {
        return await benchRoute(req, env, url);
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 400 });
      }
    }
    const tag = url.searchParams.get("bench");
    const counted: Calls = { get: 0, put: 0, delete: 0, list: 0 };
    return calls.run(counted, async () => {
      const pending: Promise<unknown>[] = [];
      const innerCtx = new Proxy(ctx, {
        get(target, prop) {
          if (prop === "waitUntil") {
            return (p: Promise<unknown>) => {
              pending.push(p);
              target.waitUntil(p);
            };
          }
          const value = Reflect.get(target, prop, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const t0 = Date.now();
      const res = await inner.fetch!(
        req as Request<unknown, IncomingRequestCfProperties>,
        env,
        innerCtx,
      );
      const base = { tag, epoch: env.BENCH_EPOCH ?? null, cold };
      log({
        ...base,
        phase: "response",
        status: res.status,
        ms: Date.now() - t0,
        calls: { ...counted },
        waitUntil: pending.length,
      });
      if (pending.length > 0) {
        ctx.waitUntil(
          Promise.allSettled(pending).then((settled) => {
            log({
              ...base,
              phase: "settled",
              ms: Date.now() - t0,
              calls: { ...counted },
              rejected: settled
                .filter((s) => s.status === "rejected")
                .map((s) => String((s as PromiseRejectedResult).reason)),
            });
          }),
        );
      }
      return res;
    });
  },
} satisfies ExportedHandler<BenchEnv>;
