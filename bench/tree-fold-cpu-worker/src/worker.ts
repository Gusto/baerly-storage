/**
 * The deployed tree fold CPU bench Worker. One `POST /bench/fold` runs one
 * fold tick of one cell (`../fold-step.ts`) and nothing else, so the
 * invocation's platform `cpuTime` (from `wrangler tail`) is the tick's CPU.
 * Every route needs `authorization: Bearer <BENCH_SECRET>`.
 *
 * - `r2` cells fold over the R2 binding (`r2BindingStorage`), every binding
 *   call counted.
 * - `memory` cells fold over a fresh in-isolate MemoryStorage built from
 *   the copy a prior `POST /bench/load` cached in this isolate; a fold that
 *   lands on another isolate answers 409 and the driver reloads.
 *
 * Each fold logs one `TFBENCH {...}` line (cell, tag, cold flag, epoch,
 * entries folded, ledger charge, nodes written, in-isolate wall time).
 * Fixture routes: `objects` (batch PUT), `reset`, `load`, `list`, `wipe`.
 * Synthetic fixtures only.
 */
import { r2BindingStorage } from "@baerly/adapter-cloudflare";
import { MAINTENANCE_PROFILE_CF_PAID, type Storage } from "@baerly/protocol";
import { type Cell, cellByName, collectionPrefix, fixtureByTenant, tenantRoot } from "../cells.ts";
import { memoryStorageOf, runFoldStep, sampleProblem } from "../fold-step.ts";
import { resetTenant } from "../reset.ts";

interface BenchEnv {
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

let coldIsolate = true;

/** This isolate's copy of one tenant's collection, for `memory` cells. */
let cached: { readonly tenant: string; readonly objects: Map<string, Uint8Array> } | null = null;

/** The binding with every call counted into `calls`. */
const countingBucket = (bucket: R2Bucket, calls: Calls): R2Bucket =>
  ({
    get: (...args: Parameters<R2Bucket["get"]>) => {
      calls.get += 1;
      return bucket.get(...args);
    },
    put: (...args: Parameters<R2Bucket["put"]>) => {
      calls.put += 1;
      return bucket.put(...args);
    },
    delete: (...args: Parameters<R2Bucket["delete"]>) => {
      calls.delete += 1;
      return bucket.delete(...args);
    },
    list: (...args: Parameters<R2Bucket["list"]>) => {
      calls.list += 1;
      return bucket.list(...args);
    },
  }) as unknown as R2Bucket;

const authorized = (req: Request, env: BenchEnv): boolean =>
  typeof env.BENCH_SECRET === "string" &&
  env.BENCH_SECRET.length >= 32 &&
  req.headers.get("authorization") === `Bearer ${env.BENCH_SECRET}`;

const BENCH_ROOT = "app/tf/tenant/";
const assertBenchKey = (key: string): string => {
  if (!key.startsWith(BENCH_ROOT) || key.includes("..")) {
    throw new Error(`key must start with ${BENCH_ROOT}`);
  }
  return key;
};

const tenantParam = (url: URL): string => {
  const tenant = url.searchParams.get("tenant") ?? "";
  if (fixtureByTenant(tenant) === undefined) {
    throw new Error(`unknown tenant ${JSON.stringify(tenant)}`);
  }
  return tenant;
};

/** Every object under `prefix`, read into memory. */
const readAll = async (bucket: R2Bucket, prefix: string): Promise<Map<string, Uint8Array>> => {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, ...(cursor !== undefined && { cursor }) });
    keys.push(...page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  const objects = new Map<string, Uint8Array>();
  for (let i = 0; i < keys.length; i += 50) {
    await Promise.all(
      keys.slice(i, i + 50).map(async (key) => {
        const got = await bucket.get(key);
        if (got !== null) {
          objects.set(key, new Uint8Array(await got.arrayBuffer()));
        }
      }),
    );
  }
  return objects;
};

const fold = async (
  cell: Cell,
  env: BenchEnv,
  tag: string | null,
  cold: boolean,
  startedAt: number,
) => {
  const calls: Calls = { get: 0, put: 0, delete: 0, list: 0 };
  let storage: Storage;
  if (cell.storage === "r2") {
    storage = r2BindingStorage(countingBucket(env.BUCKET, calls));
  } else {
    if (cached?.tenant !== cell.fixture.tenant) {
      return Response.json(
        { error: "fixture not loaded in this isolate", miss: true, cold },
        { status: 409 },
      );
    }
    storage = await memoryStorageOf(cached.objects);
  }
  // Every cell runs under the Workers Paid ledger, so under its profile.
  const result = await runFoldStep(storage, cell, {
    profile: MAINTENANCE_PROFILE_CF_PAID,
    startedAt,
  });
  const line = {
    cell: cell.name,
    tag,
    epoch: env.BENCH_EPOCH ?? null,
    cold,
    ...result,
    r2Calls: calls,
    problem: sampleProblem(cell, result),
  };
  console.log(`TFBENCH ${JSON.stringify(line)}`);
  return Response.json(line);
};

const route = async (
  req: Request,
  env: BenchEnv,
  url: URL,
  cold: boolean,
  startedAt: number,
): Promise<Response> => {
  const bucket = env.BUCKET;
  switch (`${req.method} ${url.pathname}`) {
    case "POST /bench/fold": {
      const name = url.searchParams.get("cell") ?? "";
      const cell = cellByName(name);
      if (cell === undefined) {
        return Response.json({ error: `unknown cell ${JSON.stringify(name)}` }, { status: 404 });
      }
      return await fold(cell, env, url.searchParams.get("tag"), cold, startedAt);
    }
    case "POST /bench/objects": {
      const objects = Object.entries((await req.json()) as Record<string, string>);
      for (let i = 0; i < objects.length; i += 50) {
        await Promise.all(
          objects.slice(i, i + 50).map(([key, text]) =>
            bucket.put(assertBenchKey(key), text, {
              httpMetadata: { contentType: "application/json" },
            }),
          ),
        );
      }
      return Response.json({ put: objects.length });
    }
    case "POST /bench/reset": {
      return Response.json(await resetTenant(bucket, tenantParam(url)));
    }
    case "POST /bench/load": {
      const tenant = tenantParam(url);
      cached = null;
      const objects = await readAll(bucket, `${collectionPrefix(tenant)}/`);
      cached = { tenant, objects };
      let bytes = 0;
      for (const body of objects.values()) {
        bytes += body.byteLength;
      }
      return Response.json({ tenant, objects: objects.size, bytes, cold });
    }
    case "GET /bench/list": {
      const tenant = tenantParam(url);
      let count = 0;
      let cursor: string | undefined;
      do {
        const page = await bucket.list({
          prefix: tenantRoot(tenant),
          ...(cursor !== undefined && { cursor }),
        });
        count += page.objects.length;
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor !== undefined);
      return Response.json({ tenant, objects: count });
    }
    case "POST /bench/wipe": {
      // Delete up to 5,000 objects under the bench root per request.
      cached = null;
      let deleted = 0;
      let truncated = true;
      while (truncated && deleted < 5000) {
        const page = await bucket.list({ prefix: BENCH_ROOT, limit: 1000 });
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

export default {
  async fetch(req: Request, env: BenchEnv): Promise<Response> {
    const startedAt = Date.now();
    const cold = coldIsolate;
    coldIsolate = false;
    if (!authorized(req, env)) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    try {
      return await route(req, env, new URL(req.url), cold, startedAt);
    } catch (error) {
      return Response.json({ error: String(error), cold }, { status: 500 });
    }
  },
} satisfies ExportedHandler<BenchEnv>;
