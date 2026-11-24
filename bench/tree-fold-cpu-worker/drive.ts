/**
 * Drive the deployed tree fold CPU bench Worker, one request in flight.
 *
 *   BENCH_URL=https://<worker>.workers.dev BENCH_SECRET_FILE=<file> \
 *     pnpm bench:tree-fold-cpu:drive <command> [args]
 *
 * Commands:
 *   cells [pattern...]               list the cells a pattern selects
 *   upload [tenant...]               upload fixtures (default: all), then
 *                                    check the object count and reset
 *   run [--samples=N] [--warmup=W] [pattern...]
 *                                    per cell: W warmup + N measured ticks
 *                                    (default 1 + 5); an r2 tick is followed
 *                                    by a reset that must leave exactly the
 *                                    fixture's nodes; a memory tick loads
 *                                    the fixture into the isolate first
 *   wipe                             delete every bench object (teardown)
 *
 * Patterns: a cell name, a prefix of one (`d1k5`, `d1k5-ledger`), or `*`.
 * Every request appends one JSON line to $OUT (default out/drive.jsonl).
 * A fold line carries the request `tag`, which rides in the fold URL, so
 * `analyze.ts` joins it to the tail event holding the invocation's
 * `cpuTime`.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { runAsCliEntrypoint } from "../measurement/cli-entrypoint.ts";
import {
  type Cell,
  type FixtureManifest,
  fixtureByTenant,
  FIXTURES,
  headKey,
  savedHeadKey,
  selectCells,
} from "./cells.ts";
import { OUT_DIR } from "./fixtures.ts";

export const DEFAULT_SAMPLES = 5;
export const DEFAULT_WARMUP = 1;

/** Upload request limits: well under the Workers request body cap. */
const BATCH_BYTES = 4_000_000;
const BATCH_OBJECTS = 400;

export interface RunOptions {
  readonly samples: number;
  readonly warmup: number;
  readonly cells: readonly Cell[];
}

/** Parse `run`'s arguments. */
export const parseRunOptions = (args: readonly string[]): RunOptions => {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    options: {
      samples: { type: "string", default: String(DEFAULT_SAMPLES) },
      warmup: { type: "string", default: String(DEFAULT_WARMUP) },
    },
  });
  const samples = Number(values.samples);
  const warmup = Number(values.warmup);
  if (!Number.isInteger(samples) || samples < 1) {
    throw new Error(`--samples must be a positive integer, got ${values.samples}`);
  }
  if (!Number.isInteger(warmup) || warmup < 0) {
    throw new Error(`--warmup must be a non-negative integer, got ${values.warmup}`);
  }
  return { samples, warmup, cells: selectCells(positionals) };
};

/** The tag of one tick: unique per run, cell and sample. */
export const sampleTag = (run: string, cell: string, sample: number): string =>
  `${run}.${cell}.${sample}`;

/**
 * Upload batches for one fixture: every object but the head, in order,
 * within the request limits; then the saved head copy and the head, last,
 * so a partial upload never has a head.
 */
export const uploadBatches = (
  tenant: string,
  objects: Readonly<Record<string, string>>,
): Record<string, string>[] => {
  const head = headKey(tenant);
  const headText = objects[head];
  if (headText === undefined) {
    throw new Error(`${tenant}: fixture has no head`);
  }
  const batches: Record<string, string>[] = [];
  let batch: Record<string, string> = {};
  let count = 0;
  let bytes = 0;
  for (const [key, text] of Object.entries(objects)) {
    if (key === head) {
      continue;
    }
    if (count > 0 && (count >= BATCH_OBJECTS || bytes + text.length > BATCH_BYTES)) {
      batches.push(batch);
      batch = {};
      count = 0;
      bytes = 0;
    }
    batch[key] = text;
    count += 1;
    bytes += text.length;
  }
  if (count > 0) {
    batches.push(batch);
  }
  batches.push({ [savedHeadKey(tenant)]: headText }, { [head]: headText });
  return batches;
};

// ── HTTP ─────────────────────────────────────────────────────────────────

interface Client {
  call(
    method: string,
    path: string,
    json?: unknown,
  ): Promise<{ status: number; body: Record<string, unknown>; ms: number }>;
}

const httpClient = (base: string, secret: string): Client => ({
  async call(method, path, json) {
    const t0 = performance.now();
    const res = await fetch(new URL(path, base), {
      method,
      headers: {
        authorization: `Bearer ${secret}`,
        ...(json !== undefined && { "content-type": "application/json" }),
      },
      ...(json !== undefined && { body: JSON.stringify(json) }),
      signal: AbortSignal.timeout(900_000),
    });
    const text = await res.text();
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = { text: text.slice(0, 2000) };
    }
    return { status: res.status, body, ms: performance.now() - t0 };
  },
});

const ok = async (client: Client, method: string, path: string, json?: unknown) => {
  const r = await client.call(method, path, json);
  if (r.status !== 200) {
    throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(r.body).slice(0, 500)}`);
  }
  return r.body;
};

// ── Commands ─────────────────────────────────────────────────────────────

const readManifests = (): FixtureManifest[] =>
  JSON.parse(readFileSync(join(OUT_DIR, "manifest.json"), "utf8")) as FixtureManifest[];

const manifestOf = (manifests: readonly FixtureManifest[], tenant: string): FixtureManifest => {
  const m = manifests.find((x) => x.tenant === tenant);
  if (m === undefined) {
    throw new Error(`no manifest for ${tenant}; run pnpm bench:tree-fold-cpu:fixtures`);
  }
  return m;
};

/** Reset `tenant` and check it is exactly its fixture's nodes again. */
const reset = async (client: Client, m: FixtureManifest) => {
  const r = (await ok(client, "POST", `/bench/reset?tenant=${m.tenant}`)) as {
    deleted: number;
    nodes: number;
  };
  if (r.nodes !== m.nodes) {
    throw new Error(`${m.tenant}: reset left ${r.nodes} nodes, the fixture has ${m.nodes}`);
  }
  return r;
};

const upload = async (client: Client, m: FixtureManifest, log: (l: object) => void) => {
  const objects = JSON.parse(readFileSync(join(OUT_DIR, "fixtures", m.file), "utf8")) as Record<
    string,
    string
  >;
  let put = 0;
  for (const batch of uploadBatches(m.tenant, objects)) {
    const r = (await ok(client, "POST", "/bench/objects", batch)) as { put: number };
    put += r.put;
  }
  const listed = (await ok(client, "GET", `/bench/list?tenant=${m.tenant}`)) as {
    objects: number;
  };
  // The saved head copy is the one object outside the fixture.
  if (listed.objects !== m.objects + 1) {
    throw new Error(`${m.tenant}: ${listed.objects} objects stored, expected ${m.objects + 1}`);
  }
  const r = await reset(client, m);
  log({ kind: "upload", tenant: m.tenant, put, objects: listed.objects, nodes: r.nodes });
};

const runCells = async (
  client: Client,
  options: RunOptions,
  manifests: readonly FixtureManifest[],
  log: (l: object) => void,
) => {
  const run = new Date().toISOString().replaceAll(/[-:.]/g, "").slice(0, 15);
  // The tenant the last load cached; the Worker answers 409 when a tick
  // lands on an isolate that does not hold it.
  const isolate: { loaded: string | null } = { loaded: null };
  const load = async (tenant: string) => {
    const r = await ok(client, "POST", `/bench/load?tenant=${tenant}`);
    log({ ...r, kind: "load", run, tenant });
    isolate.loaded = tenant;
  };
  const resetDone = new Set<string>();
  for (const cell of options.cells) {
    const m = manifestOf(manifests, cell.fixture.tenant);
    if (cell.storage === "r2" && !resetDone.has(m.tenant)) {
      await reset(client, m);
      resetDone.add(m.tenant);
    }
    for (let i = 0; i < options.warmup + options.samples; i++) {
      const tag = sampleTag(run, cell.name, i);
      const path = `/bench/fold?cell=${cell.name}&tag=${encodeURIComponent(tag)}`;
      let r;
      for (let attempt = 0; ; attempt++) {
        if (cell.storage === "memory" && isolate.loaded !== m.tenant) {
          await load(m.tenant);
        }
        r = await client.call("POST", path);
        if (!(r.status === 409 && r.body["miss"] === true) || attempt >= 3) {
          break;
        }
        // The tick landed on an isolate without the fixture: reload there.
        isolate.loaded = null;
      }
      // The driver's fields go last, so the Worker's body cannot shadow them.
      log({
        ...r.body,
        kind: "fold",
        run,
        cell: cell.name,
        sample: i,
        warmup: i < options.warmup,
        tag,
        status: r.status,
        clientMs: Math.round(r.ms),
      });
      if (cell.storage === "r2") {
        const reset1 = await reset(client, m);
        log({ ...reset1, kind: "reset", run, cell: cell.name, sample: i });
      }
    }
  }
};

const main = async (): Promise<number> => {
  const [command, ...args] = process.argv.slice(2);
  if (command === "cells") {
    for (const c of selectCells(args)) {
      console.log(c.name);
    }
    return 0;
  }
  const base = process.env["BENCH_URL"];
  const secretFile = process.env["BENCH_SECRET_FILE"];
  if (base === undefined || secretFile === undefined) {
    throw new Error("set BENCH_URL and BENCH_SECRET_FILE");
  }
  const client = httpClient(base, readFileSync(secretFile, "utf8").trim());
  const out = process.env["OUT"] ?? join(OUT_DIR, "drive.jsonl");
  mkdirSync(dirname(out), { recursive: true });
  const log = (line: object): void => {
    const text = JSON.stringify({ ts: new Date().toISOString(), ...line });
    appendFileSync(out, `${text}\n`);
    console.log(text);
  };
  switch (command) {
    case "upload": {
      const manifests = readManifests();
      const tenants = args.length === 0 ? FIXTURES.map((f) => f.tenant) : args;
      for (const t of tenants) {
        if (fixtureByTenant(t) === undefined) {
          throw new Error(`unknown tenant ${t}`);
        }
        await upload(client, manifestOf(manifests, t), log);
      }
      return 0;
    }
    case "run": {
      await runCells(client, parseRunOptions(args), readManifests(), log);
      return 0;
    }
    case "wipe": {
      for (;;) {
        const r = (await ok(client, "POST", "/bench/wipe")) as { deleted: number; done: boolean };
        console.log(`deleted ${r.deleted}`);
        if (r.done) {
          console.log("done");
          return 0;
        }
      }
    }
    default: {
      console.error(`unknown command ${String(command)}; see the header of drive.ts`);
      return 2;
    }
  }
};

await runAsCliEntrypoint(import.meta.url, main);
