/* eslint-disable no-underscore-dangle -- `_id` is the locked
   primary-key field on document shapes (see `@baerly/protocol`'s
   `Table<T>` / `Query<T>` declarations); cleanup iterates the
   returned `_id`s by name. */

/**
 * Manual end-to-end check — Cloudflare Worker variant.
 *
 * Drives the HTTP conformance cascade + a latency probe + a long-
 * poll wall-clock check + a 401 sniff against a real deployed
 * `baerlyWorker()`. **Manual** — both gating env vars must be set
 * for the suite to run; `pnpm test` silently skips this file.
 *
 * Required env:
 *
 *   - `CF_DEPLOY_URL`  — e.g.  `https://baerly-e2e-cf.<sub>.workers.dev`
 *   - `SHARED_SECRET`  — same secret as `wrangler secret put SHARED_SECRET`
 *
 * Optional (provisioning seam — needed for the conformance cascade
 * but not for the latency / long-poll / 401 probes):
 *
 *   - `CF_R2_S3_ENDPOINT`     — `https://<accountid>.r2.cloudflarestorage.com`
 *   - `CF_R2_ACCESS_KEY_ID`   — R2 API token (object read/write)
 *   - `CF_R2_SECRET_ACCESS_KEY` — R2 API token secret
 *   - `CF_R2_BUCKET`          — bucket name (defaults to `baerly-e2e-cf`)
 *
 * There is no "create table" HTTP route, so the cascade needs a
 * direct `Storage` handle to seed `current.json` per fresh table.
 * The test process opens its own `S3HttpStorage` against the R2
 * S3-compat endpoint to satisfy the seam; the deployed Worker
 * continues to read R2 via the in-cell binding fast-path.
 *
 * See `manual-e2e/README.md` for the full lifecycle.
 */

import { AwsClient } from "aws4fetch";
import { DOMParser } from "@xmldom/xmldom";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  CURRENT_JSON_SCHEMA_VERSION,
  createCurrentJson,
  type Storage,
} from "@baerly/protocol";
import { S3HttpStorage } from "@baerly/adapter-node";
import {
  runHttpConformanceCascade,
  type HttpFetch,
} from "../../tests/fixtures/http-conformance-cascade.ts";

const CF_URL = process.env["CF_DEPLOY_URL"];
const SECRET = process.env["SHARED_SECRET"];
// Tenant the inline sharedSecret Verifier in `manual-e2e/cloudflare/
// worker-entry.ts` maps every authorized request to. Hard-coded
// (the check is single-tenant); change in lockstep with the deploy
// entry's verifier closure.
const TENANT = "default";
const APP = "e2e";

// Per-run namespace so concurrent runs don't collide and so cleanup
// can scope its sweep. The cascade itself mints fresh tables inside
// its body; this prefix only scopes the latency / long-poll probes.
const RUN_PREFIX = `e2e-${Date.now()}`;

describe.runIf(CF_URL !== undefined && SECRET !== undefined)(
  "real-deploy: cloudflare worker",
  () => {
    const baseUrl = CF_URL!;
    const bearer = `Bearer ${SECRET!}`;

    // Best-effort cleanup of the latency-probe / long-poll tables.
    // The conformance cascade's fresh tables are not cleaned here —
    // they share the deploy bucket and are scoped under per-test UUID
    // suffixes, so they accumulate. A manual sweep with
    // `wrangler r2 object delete` (see `manual-e2e/README.md`) handles
    // bulk cleanup between runs.
    const cleanupTables: string[] = [];
    afterAll(async () => {
      for (const table of cleanupTables) {
        try {
          const list = await fetch(`${baseUrl}/v1/t/${table}`, {
            headers: { authorization: bearer },
          });
          if (!list.ok) {
            continue;
          }
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
          // Best-effort. The README documents the residual-data
          // sweep step in case cleanup is interrupted.
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
      // its `_id` 100 times. There is no raw `/v1/<key>` route
      // (see `packages/server/src/contract.ts`); the latency probe
      // exercises the same code path real readers hit.
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
      console.log(`CF GET P50=${p50.toFixed(1)}ms P95=${p95.toFixed(1)}ms P99=${p99.toFixed(1)}ms`);
      expect(p95).toBeLessThan(100);
      expect(p99).toBeLessThan(500);
    }, 60_000);

    test("10 long-polls within 26s wall-clock", async () => {
      // 10 concurrent long-polls + 10 writes. Each poll must return
      // < 26 s wall-clock (1 s buffer over the server-side 25 s
      // budget) and observe at least one event. See ticket 26 for
      // the long-poll contract.
      const table = `${RUN_PREFIX}-longpoll`;
      cleanupTables.push(table);

      // Seed one write so `current.json` is populated and the poll's
      // empty-cursor → `log_seq_start` path is unambiguous. The
      // long-poll cursor below skips past this seed.
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

      // Let the polls arm. The server's poll-interval is ~1 s; a 200
      // ms delay is generous given the wire RTT.
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
      console.log(`CF long-poll walls: ${walls.map((w) => w.toFixed(0)).join(",")}ms`);
    }, 30_000);

    // ── HTTP conformance cascade ────────────────────────────────────
    //
    // Gated on the provisioning-seam env vars (`CF_R2_*`). The
    // cascade needs a `Storage` handle to seed `current.json` per
    // fresh table — there is no "create table" HTTP route — and
    // the test process opens its own `S3HttpStorage` against the
    // R2 S3-compat endpoint for that purpose. Without the env vars,
    // this cascade is skipped; the latency / long-poll / 401 probes
    // above still run.
    const R2_ENDPOINT = process.env["CF_R2_S3_ENDPOINT"];
    const R2_ACCESS = process.env["CF_R2_ACCESS_KEY_ID"];
    const R2_SECRET = process.env["CF_R2_SECRET_ACCESS_KEY"];
    const R2_BUCKET = process.env["CF_R2_BUCKET"] ?? "baerly-e2e-cf";

    const cascadeReady =
      R2_ENDPOINT !== undefined && R2_ACCESS !== undefined && R2_SECRET !== undefined;

    describe.runIf(cascadeReady)("conformance cascade (via R2 S3-compat)", () => {
      // Deferred so `new AwsClient(...)` / `new S3HttpStorage(...)` are
      // never called when `cascadeReady` is false — the describe callback
      // is still invoked by vitest's collector even for skipped suites.
      let aws: AwsClient;
      let storage: Storage;
      beforeAll(() => {
        aws = new AwsClient({
          accessKeyId: R2_ACCESS!,
          secretAccessKey: R2_SECRET!,
          region: "auto",
          service: "s3",
        });
        storage = new S3HttpStorage({
          endpoint: R2_ENDPOINT!,
          bucket: R2_BUCKET,
          xmlParser: new DOMParser(),
          sign: (req) => aws.sign(req),
        });
      });

      // The cascade builds requests against `http://test.local/v1/...`
      // and sends `Authorization: Bearer ${bearerToken}` (we pass
      // `SECRET` as `bearerToken` below, so the header is already
      // e2e-correct). Rewrite the URL host onto the deploy URL and
      // forward verbatim.
      const e2eFetch: HttpFetch = async (req) => {
        const url = new URL(req.url);
        const rewritten = `${baseUrl}${url.pathname}${url.search}`;
        const headers = new Headers(req.headers);
        // `Request` body is one-shot per consume; serialize once for
        // non-GET/HEAD methods. GET/HEAD have null bodies, so a
        // sentinel `undefined` is safe.
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
        name: "cloudflare-real-deploy",
        fetch: e2eFetch,
        provisionTable: async (table) => {
          const key = `app/${APP}/tenant/${TENANT}/manifests/${table}/current.json`;
          await createCurrentJson(storage, key, {
            schema_version: CURRENT_JSON_SCHEMA_VERSION,
            snapshot: null,
            next_seq: 0,
            log_seq_start: 0,
            writer_fence: {
              epoch: 0,
              owner: "manual-e2e-cf",
              claimed_at: "",
            },
          });
        },
        options: {
          // Real CF deploy doesn't emit ETag headers either; CAS
          // skip stays the default. Cache API is in play (ticket 27)
          // but the cascade tolerates 200 fall-through.
          supportsCacheApi: true,
          // Real fetch on a real deploy carries AbortSignal cleanly;
          // keep the default `supportsAbort: true`.
          bearerToken: SECRET!,
          tenantPrefix: TENANT,
        },
      });
    });
  },
);
