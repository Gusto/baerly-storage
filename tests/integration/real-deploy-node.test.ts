/* eslint-disable no-underscore-dangle -- `_id` is the locked
   primary-key field on document shapes (see `@baerly/protocol`'s
   `Table<T>` / `Query<T>` declarations); cleanup iterates the
   returned `_id`s by name. */

/**
 * Real-deploy gate — Node host variant.
 *
 * Drives the HTTP conformance cascade + a latency probe + a long-
 * poll wall-clock check + a 401 sniff against a real deployed
 * `createListener()`. **Manual** — both gating env vars must be set
 * for the suite to run; `pnpm test` silently skips this file.
 *
 * Required env:
 *
 *   - `NODE_DEPLOY_URL`      — e.g. `http://localhost:8080`
 *   - `SHARED_SECRET`        — same value as the container's env
 *
 * Optional (provisioning seam — needed for the conformance cascade
 * but not for the latency / long-poll / 401 probes):
 *
 *   - `AWS_ACCESS_KEY_ID`     — same IAM creds the container uses
 *   - `AWS_SECRET_ACCESS_KEY`
 *   - `AWS_REGION`            — default `us-east-1`
 *   - `BUCKET`                — same bucket the container writes to
 *   - `S3_ENDPOINT`           — optional override (R2 S3-compat etc.)
 *
 * Phase 6 has no "create table" HTTP route, so the cascade needs a
 * direct `Storage` handle to seed `current.json` per fresh table.
 * The test process opens its own `S3HttpStorage` against the same
 * bucket the container talks to.
 *
 * See `deploy/README.md` for the full lifecycle.
 */

import { AwsClient } from "aws4fetch";
import { DOMParser } from "@xmldom/xmldom";
import { afterAll, describe, expect, test } from "vitest";
import {
  CURRENT_JSON_SCHEMA_VERSION,
  S3HttpStorage,
  createCurrentJson,
  type Storage,
} from "@baerly/protocol";
import { runHttpConformanceCascade, type HttpFetch } from "../fixtures/http-conformance-cascade.ts";

const NODE_URL = process.env.NODE_DEPLOY_URL;
const SECRET = process.env.SHARED_SECRET;
// Tenant the inline sharedSecret Verifier in `deploy/node/server-
// entry.ts` maps every authorized request to. Hard-coded (the gate
// is single-tenant); change in lockstep with the deploy entry.
const TENANT = process.env.TENANT ?? "default";
const APP = process.env.APP ?? "gate";

const RUN_PREFIX = `gate-${Date.now()}`;

describe.runIf(NODE_URL !== undefined && SECRET !== undefined)("real-deploy: node host", () => {
  const baseUrl = NODE_URL!;
  const bearer = `Bearer ${SECRET!}`;

  const cleanupTables: string[] = [];
  afterAll(async () => {
    for (const table of cleanupTables) {
      try {
        const list = await fetch(`${baseUrl}/v1/t/${table}`, {
          headers: { authorization: bearer },
        });
        if (!list.ok) continue;
        const { data } = (await list.json()) as {
          readonly data: ReadonlyArray<{ readonly _id: string }>;
        };
        for (const row of data) {
          await fetch(`${baseUrl}/v1/t/${table}/${row._id}`, {
            method: "DELETE",
            headers: { authorization: bearer },
          }).catch(() => undefined);
        }
      } catch {
        // Best-effort. See `deploy/README.md` for the manual
        // residual-data sweep.
      }
    }
  });

  test("unauthenticated request → 401 Unauthorized", async () => {
    const res = await fetch(`${baseUrl}/v1/t/auth-missing`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as {
      readonly error?: { readonly code?: string };
    };
    expect(body.error?.code).toBe("Unauthorized");
  });

  test("100-GET latency budget", async () => {
    // Seed one ~1 KB doc through the public POST route, then GET
    // its `_id` 100 times. Single-AZ `us-east-1` S3 budget is
    // tighter than CF's because the request path is one network
    // hop (test → Node container → S3) without the extra Worker
    // edge layer.
    const table = `${RUN_PREFIX}-latency`;
    cleanupTables.push(table);
    const payload = "x".repeat(1024);
    const post = await fetch(`${baseUrl}/v1/t/${table}`, {
      method: "POST",
      headers: { authorization: bearer, "content-type": "application/json" },
      body: JSON.stringify({ doc: { payload } }),
    });
    expect(post.status).toBe(201);
    const { _id: id } = (await post.json()) as { readonly _id: string };

    const samples: number[] = [];
    for (let i = 0; i < 100; i += 1) {
      const t0 = performance.now();
      const res = await fetch(`${baseUrl}/v1/t/${table}/${id}`, {
        headers: { authorization: bearer },
      });
      expect(res.status).toBe(200);
      await res.arrayBuffer();
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    const p50 = samples[49]!;
    const p95 = samples[94]!;
    const p99 = samples[98]!;
    console.log(`Node GET P50=${p50.toFixed(1)}ms P95=${p95.toFixed(1)}ms P99=${p99.toFixed(1)}ms`);
    expect(p95).toBeLessThan(50);
    expect(p99).toBeLessThan(500);
  }, 60_000);

  test("10 long-polls within 26s wall-clock", async () => {
    const table = `${RUN_PREFIX}-longpoll`;
    cleanupTables.push(table);

    const seed = await fetch(`${baseUrl}/v1/t/${table}`, {
      method: "POST",
      headers: { authorization: bearer, "content-type": "application/json" },
      body: JSON.stringify({ doc: { seed: true } }),
    });
    expect(seed.status).toBe(201);

    const longPolls = Array.from({ length: 10 }, async () => {
      const t0 = performance.now();
      const res = await fetch(`${baseUrl}/v1/since?table=${table}&cursor=`, {
        headers: { authorization: bearer },
      });
      const wall = performance.now() - t0;
      expect(res.status).toBe(200);
      expect(wall).toBeLessThan(26_000);
      return wall;
    });

    await new Promise((r) => setTimeout(r, 200));

    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        fetch(`${baseUrl}/v1/t/${table}`, {
          method: "POST",
          headers: { authorization: bearer, "content-type": "application/json" },
          body: JSON.stringify({ doc: { lp: i } }),
        }),
      ),
    );

    const walls = await Promise.all(longPolls);
    console.log(`Node long-poll walls: ${walls.map((w) => w.toFixed(0)).join(",")}ms`);
  }, 30_000);

  // ── HTTP conformance cascade ────────────────────────────────────
  //
  // Gated on the AWS env vars. The cascade opens its own
  // `S3HttpStorage` against the same bucket the container writes
  // to so `provisionTable` can seed `current.json` per fresh
  // table. Without these vars, the cascade is skipped; the
  // latency / long-poll / 401 probes above still run.
  const AWS_ACCESS = process.env.AWS_ACCESS_KEY_ID;
  const AWS_SECRET_KEY = process.env.AWS_SECRET_ACCESS_KEY;
  const AWS_REGION = process.env.AWS_REGION ?? "us-east-1";
  const BUCKET = process.env.BUCKET;
  const S3_ENDPOINT = process.env.S3_ENDPOINT ?? `https://s3.${AWS_REGION}.amazonaws.com`;

  const cascadeReady =
    AWS_ACCESS !== undefined && AWS_SECRET_KEY !== undefined && BUCKET !== undefined;

  describe.runIf(cascadeReady)("conformance cascade (via S3)", () => {
    const aws = new AwsClient({
      accessKeyId: AWS_ACCESS!,
      secretAccessKey: AWS_SECRET_KEY!,
      region: AWS_REGION,
      service: "s3",
    });
    const storage: Storage = new S3HttpStorage({
      endpoint: S3_ENDPOINT,
      bucket: BUCKET!,
      xmlParser: new DOMParser(),
      sign: (req) => aws.sign(req),
    });

    // Cascade builds requests against `http://test.local/v1/...`.
    // Rewrite the host onto the deploy URL; the bearer is already
    // gate-correct via the `bearerToken` option below.
    const gateFetch: HttpFetch = async (req) => {
      const url = new URL(req.url);
      const rewritten = `${baseUrl}${url.pathname}${url.search}`;
      const headers = new Headers(req.headers);
      const body =
        req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
      return fetch(rewritten, {
        method: req.method,
        headers,
        body,
        signal: req.signal,
      });
    };

    runHttpConformanceCascade({
      name: "node-real-deploy",
      fetch: gateFetch,
      provisionTable: async (table) => {
        const key = `app/${APP}/tenant/${TENANT}/manifests/${table}/current.json`;
        await createCurrentJson(storage, key, {
          schema_version: CURRENT_JSON_SCHEMA_VERSION,
          snapshot: null,
          next_seq: 0,
          writer_fence: {
            epoch: 0,
            owner: "real-deploy-node-gate",
            claimed_at: "",
          },
        });
      },
      options: {
        bearerToken: SECRET!,
        tenantPrefix: TENANT,
        // Node listener has no `caches.default`; the conditional-
        // GET block falls through to plain 200 + body as on the
        // Minio variant.
        supportsCacheApi: false,
      },
    });
  });
});
