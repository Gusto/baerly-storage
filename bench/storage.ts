/**
 * Bench-side `Storage` factory. Wraps the production `S3HttpStorage`
 * in a `CountingStorage` proxy so the harness can compute Class A /
 * Class B op counts and a per-writer-per-hour Class A rate — the
 * wire-level analogue of the in-process counting proxy in
 * `tests/integration/phase5-end-to-end.test.ts`.
 *
 * Endpoint choices: Minio host port (`:9102`) for the `direct` path,
 * or the Toxiproxy listener (`:9104`) when toxics are installed. Both
 * are baked into `docker-compose.yml` and brought up by
 * `pnpm dev:storage`.
 */

import { AwsClient } from "aws4fetch";
import {
  type Storage,
  type StorageGetOptions,
  type StorageGetResult,
  type StoragePutOptions,
  type StoragePutResult,
  type StorageListEntry,
  BaerlyError,
} from "@baerly/protocol";
import { S3HttpStorage } from "@baerly/adapter-node";
import type { StorageSnapshot, OpLatencyTail } from "./types.ts";

export interface BenchStorageOpts {
  /**
   * `direct` → http://127.0.0.1:9102 (Minio host port from
   * docker-compose).
   * `toxiproxy` → http://127.0.0.1:9104 (Toxiproxy listener,
   * forwarded to minio:9000 by the toxiproxy-config-0 one-shot
   * service in docker-compose.yml).
   */
  readonly via: "direct" | "toxiproxy";
  readonly bucket: string;
}

/**
 * Cap on per-op latency samples retained. At 100k samples × 5 verbs ×
 * 8 bytes/double = ~4 MB max memory per `CountingStorage`. Multi-
 * million-op runs hit this ceiling; nearest-rank p50/p95/p99 stay
 * stable under FIFO drop for the quasi-stationary workloads the
 * load-harness presets produce. If a future workload class needs full-
 * run latency retention, switch this file to a reservoir sampler —
 * out of scope for ticket 50.
 */
const MAX_LATENCY_SAMPLES_PER_OP = 100_000;

/**
 * First two `/`-separated segments of a key, or the whole key if it
 * has fewer than two segments. Stable bucket for per-prefix
 * attribution: keys are tenant-scoped (`tenant-NNN/collection-XXX/...`)
 * so the two-segment cut maps to the (tenant, collection) pair the
 * harness usually wants. Returning the full key in the degenerate
 * case avoids collapsing every short key into the empty bucket.
 */
function prefixOf(key: string): string {
  let firstSlash = -1;
  for (let i = 0; i < key.length; i++) {
    if (key.charCodeAt(i) !== 47) {
      continue;
    } // 47 = '/'
    if (firstSlash === -1) {
      firstSlash = i;
      continue;
    }
    return key.slice(0, i);
  }
  return key;
}

function bumpPrefix(
  map: Map<string, { get: number; put: number; head: number; list: number; delete: number }>,
  key: string,
  op: "get" | "put" | "head" | "list" | "delete",
): void {
  const pfx = prefixOf(key);
  let row = map.get(pfx);
  if (row === undefined) {
    row = { get: 0, put: 0, head: 0, list: 0, delete: 0 };
    map.set(pfx, row);
  }
  row[op] += 1;
}

function tailOrUndefined(samples: number[]): OpLatencyTail | undefined {
  if (samples.length === 0) {
    return undefined;
  }
  const sorted = [...samples].toSorted((a, b) => a - b);
  const pick = (q: number): number => {
    const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * q));
    return sorted[idx]!;
  };
  return { p50: pick(0.5), p95: pick(0.95), p99: pick(0.99) };
}

/**
 * Counting wrapper over `S3HttpStorage`. Tracks Class A operations
 * (put / delete / list — the S3/R2 mutating-or-enumerating verbs)
 * and Class B (get / head). Used by the harness to compute
 * per-writer Class A op rate per hour and assert the cost-model
 * bound from `tests/integration/phase5-end-to-end.test.ts`.
 *
 * Extended with per-op counters, byte-volume tracking, per-op latency
 * samples, and per-prefix attribution for load-harness
 * snapshots. All existing fields are preserved; new fields are additive.
 */
export class CountingStorage implements Storage {
  classAOps = 0;
  classBOps = 0;
  conflict412 = 0;
  rateLimit429 = 0;

  // Per-verb counters. These are the source of truth for the
  // snapshot. The legacy `classAOps` / `classBOps` fields are derived
  // from these on every increment so old callers keep observing the
  // same totals.
  getCount = 0;
  putCount = 0;
  headCount = 0; // always 0 in current code paths; carried for shape
  listCount = 0;
  deleteCount = 0;

  // Byte volume.
  bytesRead = 0;
  bytesWritten = 0;

  // Per-op latency samples (ms). One entry per completed op (success
  // OR observed failure response — anything that consumed wall-clock
  // against the wire). Bounded by `MAX_LATENCY_SAMPLES_PER_OP` to keep
  // memory tractable under multi-million-op runs; oldest entries are
  // dropped when the cap is hit (FIFO drop — see constant doc).
  readonly latenciesByOp: {
    get: number[];
    put: number[];
    head: number[];
    list: number[];
    delete: number[];
  } = { get: [], put: [], head: [], list: [], delete: [] };

  // Per-prefix attribution. The prefix is the first TWO segments of
  // the key — `tenant-007/collection-notes` — or the full key if it
  // has fewer than two `/` separators.
  readonly opsByPrefix: Map<
    string,
    {
      get: number;
      put: number;
      head: number;
      list: number;
      delete: number;
    }
  > = new Map();

  private readonly inner: Storage;

  constructor(inner: Storage) {
    this.inner = inner;
  }

  async get(key: string, opts?: StorageGetOptions): Promise<StorageGetResult | null> {
    this.classBOps++;
    this.getCount++;
    bumpPrefix(this.opsByPrefix, key, "get");
    const t0 = performance.now();
    try {
      const res = await this.inner.get(key, opts);
      if (res !== null) {
        this.bytesRead += res.body.byteLength;
      }
      return res;
    } finally {
      this.recordLatency("get", performance.now() - t0);
    }
  }

  async put(key: string, body: Uint8Array, opts?: StoragePutOptions): Promise<StoragePutResult> {
    this.classAOps++;
    this.putCount++;
    this.bytesWritten += body.byteLength;
    bumpPrefix(this.opsByPrefix, key, "put");
    const t0 = performance.now();
    try {
      return await this.inner.put(key, body, opts);
    } catch (error: unknown) {
      // 412 surfaces as BaerlyError{code:"Conflict"}; 429 / 503-SlowDown
      // surface as BaerlyError{code:"NetworkError"} once the retry budget
      // is exhausted (bench passes retries=0, so on the first wire reply).
      // 429 has no dedicated code, so fall back to message sniffing for
      // the rate-limit bucket only.
      if (error instanceof BaerlyError) {
        if (error.code === "Conflict") {
          this.conflict412++;
        } else if (
          error.code === "NetworkError" &&
          (error.message.includes("429") || error.message.includes("SlowDown"))
        ) {
          this.rateLimit429++;
        }
      }
      throw error;
    } finally {
      this.recordLatency("put", performance.now() - t0);
    }
  }

  async delete(key: string, opts?: { signal?: AbortSignal }): Promise<void> {
    this.classAOps++;
    this.deleteCount++;
    bumpPrefix(this.opsByPrefix, key, "delete");
    const t0 = performance.now();
    try {
      return await this.inner.delete(key, opts);
    } finally {
      this.recordLatency("delete", performance.now() - t0);
    }
  }

  async *list(
    prefix: string,
    opts?: { startAfter?: string; maxKeys?: number; signal?: AbortSignal },
  ): AsyncIterable<StorageListEntry> {
    this.classAOps++;
    this.listCount++;
    bumpPrefix(this.opsByPrefix, prefix, "list");
    const t0 = performance.now();
    try {
      for await (const entry of this.inner.list(prefix, opts)) {
        yield entry;
      }
    } finally {
      this.recordLatency("list", performance.now() - t0);
    }
  }

  /**
   * Run-JSON shape, `object_store` + `latency_ms.by_op` +
   * `ops_by_prefix` portion. Ticket 54 (load-harness CLI) wraps this
   * inside the run envelope. Nearest-rank percentiles match
   * `bench/metrics.ts`. Verbs with no samples are omitted from
   * `latency_ms.by_op`.
   */
  snapshot(): StorageSnapshot {
    const by_op: {
      get?: OpLatencyTail;
      put?: OpLatencyTail;
      head?: OpLatencyTail;
      list?: OpLatencyTail;
      delete?: OpLatencyTail;
    } = {};
    const getLatency = tailOrUndefined(this.latenciesByOp.get);
    if (getLatency !== undefined) {
      by_op.get = getLatency;
    }
    const putLatency = tailOrUndefined(this.latenciesByOp.put);
    if (putLatency !== undefined) {
      by_op.put = putLatency;
    }
    const headLatency = tailOrUndefined(this.latenciesByOp.head);
    if (headLatency !== undefined) {
      by_op.head = headLatency;
    }
    const listLatency = tailOrUndefined(this.latenciesByOp.list);
    if (listLatency !== undefined) {
      by_op.list = listLatency;
    }
    const deleteLatency = tailOrUndefined(this.latenciesByOp.delete);
    if (deleteLatency !== undefined) {
      by_op.delete = deleteLatency;
    }

    return {
      object_store: {
        get: this.getCount,
        put: this.putCount,
        head: this.headCount,
        list: this.listCount,
        delete: this.deleteCount,
        bytes_read: this.bytesRead,
        bytes_written: this.bytesWritten,
        retries: 0, // see field doc in StorageSnapshot
        conflict_412: this.conflict412,
        rate_limit_429: this.rateLimit429,
      },
      latency_ms: { by_op },
      ops_by_prefix: Object.fromEntries(this.opsByPrefix),
    };
  }

  /**
   * Clears every counter on this instance. The harness calls this at
   * each phase boundary so per-phase `snapshot()` returns the cost of
   * that phase alone. Legacy fields are reset alongside the new ones
   * so callers reading either set observe consistent zeroes.
   */
  reset(): void {
    this.classAOps = 0;
    this.classBOps = 0;
    this.conflict412 = 0;
    this.rateLimit429 = 0;
    this.getCount = 0;
    this.putCount = 0;
    this.headCount = 0;
    this.listCount = 0;
    this.deleteCount = 0;
    this.bytesRead = 0;
    this.bytesWritten = 0;
    this.latenciesByOp.get.length = 0;
    this.latenciesByOp.put.length = 0;
    this.latenciesByOp.head.length = 0;
    this.latenciesByOp.list.length = 0;
    this.latenciesByOp.delete.length = 0;
    this.opsByPrefix.clear();
  }

  private recordLatency(op: "get" | "put" | "head" | "list" | "delete", ms: number): void {
    const arr = this.latenciesByOp[op];
    arr.push(ms);
    if (arr.length > MAX_LATENCY_SAMPLES_PER_OP) {
      arr.shift();
    }
  }
}

function endpointFor(via: BenchStorageOpts["via"]): string {
  return via === "direct" ? "http://127.0.0.1:9102" : "http://127.0.0.1:9104";
}

function makeSigner(): AwsClient {
  // Credentials match `docker-compose.yml`'s Minio service. Local
  // only; never published.
  return new AwsClient({
    accessKeyId: "baerly",
    secretAccessKey: "ZOAmumEzdsUUcVlQ",
    region: "us-east-1",
    service: "s3",
  });
}

export function buildBenchStorage(opts: BenchStorageOpts): CountingStorage {
  const signer = makeSigner();
  const inner = new S3HttpStorage({
    endpoint: endpointFor(opts.via),
    bucket: opts.bucket,
    sign: (req: Request) => signer.sign(req),
    retries: 0, // bench owns retry policy
  });
  return new CountingStorage(inner);
}

/**
 * Idempotent bucket create. Tolerates 200 / 204 (created) and 409
 * BucketAlreadyOwnedByYou so calling this on every bench invocation
 * is safe.
 */
export async function ensureBucket(opts: BenchStorageOpts): Promise<void> {
  const signer = makeSigner();
  const url = `${endpointFor(opts.via)}/${opts.bucket}`;
  const signed = await signer.sign(new Request(url, { method: "PUT" }));
  const res = await fetch(signed);
  if (res.status !== 200 && res.status !== 204 && res.status !== 409) {
    const body = await res.text();
    throw new Error(`bench: bucket create ${url} failed: ${res.status} ${body}`);
  }
}
