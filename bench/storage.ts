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
import { DOMParser } from "@xmldom/xmldom";
import {
  type Storage,
  type StorageGetOptions,
  type StorageGetResult,
  type StoragePutOptions,
  type StoragePutResult,
  type StorageListEntry,
  S3HttpStorage,
} from "@baerly/protocol";

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
 * Counting wrapper over `S3HttpStorage`. Tracks Class A operations
 * (put / delete / list — the S3/R2 mutating-or-enumerating verbs)
 * and Class B (get / head). Used by the harness to compute
 * per-writer Class A op rate per hour and assert the cost-model
 * bound from `tests/integration/phase5-end-to-end.test.ts`.
 */
export class CountingStorage implements Storage {
  classAOps = 0;
  classBOps = 0;
  conflict412 = 0;
  rateLimit429 = 0;
  private readonly inner: Storage;

  constructor(inner: Storage) {
    this.inner = inner;
  }

  async get(key: string, opts?: StorageGetOptions): Promise<StorageGetResult | null> {
    this.classBOps++;
    return this.inner.get(key, opts);
  }

  async put(key: string, body: Uint8Array, opts?: StoragePutOptions): Promise<StoragePutResult> {
    this.classAOps++;
    try {
      return await this.inner.put(key, body, opts);
    } catch (e: unknown) {
      // S3HttpStorage surfaces 412 as
      // BaerlyError{code:"InvalidResponse", message:"PreconditionFailed: …"}
      // and 429 / 503-SlowDown as
      // BaerlyError{code:"NetworkError", message: "…429…"} after the
      // retry budget is exhausted (bench passes retries=0, so it
      // surfaces on the first wire response).
      const msg = (e as { message?: string }).message ?? "";
      if (msg.includes("PreconditionFailed")) this.conflict412++;
      else if (msg.includes("429") || msg.includes("SlowDown")) this.rateLimit429++;
      throw e;
    }
  }

  async delete(key: string, opts?: { signal?: AbortSignal }): Promise<void> {
    this.classAOps++;
    return this.inner.delete(key, opts);
  }

  async *list(
    prefix: string,
    opts?: { startAfter?: string; maxKeys?: number; signal?: AbortSignal },
  ): AsyncIterable<StorageListEntry> {
    this.classAOps++;
    for await (const entry of this.inner.list(prefix, opts)) yield entry;
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
    xmlParser: new DOMParser(),
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
