/* eslint-disable no-underscore-dangle -- `_id` is the locked
   primary-key field on document shapes (see `@baerly/protocol`'s
   `Collection<T>` / `Query<T>` declarations); the cascade asserts it by
   name. */

/**
 * HTTP conformance cascade — backend-agnostic test driver.
 *
 * Mirrors `defineStorageConformanceSuite` from
 * `packages/protocol/src/storage/conformance.ts` but over the
 * HTTP wire instead of the in-process `Storage` interface.
 * Same describe-block organisation, same capability-flag policy, same
 * `beforeEach` reset pattern (each `freshTable(...)` minted in a test
 * body is its own namespace — table provisioning happens server-side
 * on first write through `Writer.commit()`, so the test only
 * needs to vary the table name).
 *
 * Pure module — no Node imports, no `node:fs`, no `node:http`, no
 * `aws4fetch`. The Workerd-side variant
 * (`packages/adapter-cloudflare/src/http-conformance.test.ts`) loads
 * this file directly; runtime-specific setup (Node listener spin-up,
 * Minio bucket bootstrap, miniflare R2 binding wiring) lives in the
 * two call sites.
 *
 * @see tests/integration/http-conformance.test.ts (Node-side variants)
 * @see packages/adapter-cloudflare/src/http-conformance.test.ts (Workerd variant)
 * @see packages/server/src/contract.ts (URL contract + status-code policy)
 */

import { fc, test as fcTest } from "@fast-check/vitest";
import { describe, expect, test } from "vitest";
import type { DocumentData } from "@baerly/protocol";
import { CONFORMANCE_BEARER, CONFORMANCE_TENANT } from "./test-verifier.ts";

/**
 * Capability flags + arbitrary overrides for the HTTP conformance
 * cascade. Defaults match what every adapter on this branch
 * supports; variants opt out of features they don't surface yet.
 */
export interface HttpConformanceOptions {
  /** When false, the AbortSignal block is skipped. Default: true. */
  readonly supportsAbort?: boolean;
  /**
   * When false, the CAS-via-If-Match block on PATCH is skipped.
   *
   * Default: **false**. Ticket 25's router does not yet plumb
   * `If-Match` through to the underlying `Storage.put` CAS, so the
   * round-trip from response `ETag` → request `If-Match` is not
   * exercised over HTTP. When ticket 25 grows the plumbing, flip this
   * default to `true` and remove the per-variant override.
   */
  readonly supportsCAS?: boolean;
  /** Affects the key arbitrary's selector. Default: true. */
  readonly caseSensitiveKeys?: boolean;
  /**
   * Long-poll `/v1/since` covered. Default: true. Set false only when
   * a variant intentionally omits the route (none in tree today).
   */
  readonly supportsLongPoll?: boolean;
  /**
   * When true, the cascade assumes the call site has plumbed a short
   * `sinceTimeoutMs` (≤ ~500ms) into the listener so the idle-poll
   * wire-shape test (two back-to-back idle polls + cursor-stability)
   * completes inside the vitest default timeout instead of sitting on
   * the 25s `longPollSince` default.
   *
   * Default: **false**. The Node-side variants pass `true` because
   * `baerlyNode` exposes `sinceTimeoutMs`. The Workerd-side
   * variant pins `false` — `baerlyWorker` does not yet thread the
   * override through to `createRouter`, so an unbounded idle poll
   * would time out the test runner.
   */
  readonly supportsSinceTimeoutOverride?: boolean;
  /**
   * When true, the conditional-GET block additionally exercises the
   * Cache API path (ticket 27): a second GET issued within the same
   * test run hits `caches.default` and still respects `If-None-Match`
   * → 304. Workerd-only: the Node listener has no `caches.default`.
   *
   * Even when `true`, the cascade tolerates a 200 fall-through: the
   * router does not emit `ETag` headers on the GET response
   * today, so the Worker cache layer has no etag to compare against
   * and the 304-rewrite branch never fires. The assertion is "either
   * 304 or 200 with the body" — the load-bearing invariant is that
   * the cached path doesn't corrupt the doc shape.
   */
  readonly supportsCacheApi?: boolean;
  /** Tenant prefix the test Verifier maps to. Default: `conformance-tenant`. */
  readonly tenantPrefix?: string;
  /** Bearer token the test Verifier accepts. Default: `test-token`. */
  readonly bearerToken?: string;
  /** Override the doc-body arbitrary. Default: small JSON object. */
  readonly bodyArb?: fc.Arbitrary<DocumentData>;
  /**
   * Optional seam for the seq-overflow regression test (block 10b).
   *
   * When provided, the cascade uses this callback instead of
   * `provisionTable` to seed `current.json` with a given `next_seq` and
   * `log_seq_start`. This lets the call site pre-advance the seq counter
   * so the test only needs ONE insert to reach seq > 1023 — rather than
   * 1025 sequential HTTP inserts (which would time out the local-fs variant).
   *
   * The callback MUST create `current.json` with:
   *   `next_seq = nextSeq`, `log_seq_start = nextSeq` (no real log entries).
   * After one insert the collection's `next_seq` advances to `nextSeq + 1`
   * and the log carries exactly one entry at seq `nextSeq`.
   *
   * When omitted, the regression test still runs but falls back to
   * inserting 1025 documents sequentially (the straightforward approach).
   * Suitable for variants where storage I/O is cheap enough (memory).
   */
  readonly provisionTableAtSeq?: (table: string, nextSeq: number) => Promise<void>;
}

export type HttpFetch = (req: Request) => Promise<Response>;

/**
 * Provision `current.json` for a (test-verifier tenant, app, table)
 * triple. The HTTP surface has no "create table" endpoint;
 * the underlying `Writer.commit()` throws `InvalidResponse`
 * when `current.json` is missing. Production deployments provision
 * via `createCurrentJson()` at deploy time; tests need the same
 * step inside the runtime that owns the storage handle.
 *
 * Implementations call `createCurrentJson(storage, key, seed)` with
 * the bucket-relative key
 * `app/<app>/tenant/<tenant>/manifests/<table>/current.json`. The
 * `app`/`tenant` values come from the call site's listener wiring
 * (Node: passed to `baerlyNode({ config, ... })`; Workerd: passed
 * through the worker module's env binding).
 */
export type ProvisionTable = (table: string) => Promise<void>;

/**
 * The route prefix is hard-coded in the locked HTTP contract
 * (`packages/server/src/contract.ts:39-51`). Tests build URLs against
 * a synthetic `http://test.local` host — the listener ignores the
 * authority, only path + query matter.
 */
const BASE = "http://test.local";

/**
 * Default doc-body arbitrary. Small JSON object with a handful of
 * string/number/boolean leaves; small enough to keep fast-check
 * shrinking cheap, large enough to surface JSON-mangling bugs.
 */
const DEFAULT_BODY_ARB: fc.Arbitrary<DocumentData> = fc.dictionary(
  fc.stringMatching(/^[a-z][a-z0-9_]{0,7}$/),
  fc.oneof(fc.string({ maxLength: 32 }), fc.integer(), fc.boolean()) as fc.Arbitrary<
    string | number | boolean
  >,
  { minKeys: 0, maxKeys: 6 },
) as unknown as fc.Arbitrary<DocumentData>;

/**
 * Tiny PNG signature + IHDR — same 33-byte fixture used by the
 * storage conformance suite's binary-fidelity block. We carry it as
 * base64 in a JSON field so the encoding-fidelity test can decode and
 * compare byte-for-byte after a round-trip.
 */
const PNG_FIXTURE = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89,
]);

/** Cheap UUID-ish suffix for table names. Avoids pulling in `@baerly/protocol`'s `uuid`. */
const randSuffix = (): string =>
  Math.floor(Math.random() * 0x1_0000_0000)
    .toString(16)
    .padStart(8, "0");

const freshTable = (prefix: string): string => `${prefix}-${randSuffix()}`;

const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
};

/** Encode bytes as URL-safe base64 (atob/btoa exist in Node 24+ and Workerd). */
const bytesToBase64 = (bytes: Uint8Array): string => {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 1) {
    bin += String.fromCharCode(bytes[i]!);
  }
  return btoa(bin);
};

const base64ToBytes = (b64: string): Uint8Array => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
};

interface ErrorEnvelope {
  readonly error?: { readonly code?: string; readonly message?: string };
}

/**
 * Public entry point. Synchronously registers a `describe(`HTTP
 * conformance — ${name}`, ...)` tree against the surrounding vitest
 * context. Each describe block below maps to a storage-conformance
 * block (block 1: get/put round-trip, etc.) or is new for HTTP
 * (block 9: Auth, block 10: long-poll).
 *
 * The caller MUST register block-level lifecycle (server spin-up /
 * teardown) inside its own enclosing `describe(...)` via `beforeAll`
 * / `afterAll`. The cascade itself does not start or stop any
 * listener; it consumes one through the `fetch` argument.
 */
export const runHttpConformanceCascade = (opts: {
  readonly name: string;
  readonly fetch: HttpFetch;
  /**
   * Provision `current.json` for a fresh table. The cascade calls
   * this exactly once per `freshTable(...)` it mints, BEFORE the
   * first write to that table — matching the production deploy-time
   * `createCurrentJson` step. The cascade body itself can't reach
   * the underlying `Storage` (it only has the HTTP wire), so this
   * callback is the seam.
   */
  readonly provisionTable: ProvisionTable;
  readonly options?: HttpConformanceOptions;
}): void => {
  const o = opts.options ?? {};
  const supportsAbort = o.supportsAbort ?? true;
  const supportsCAS = o.supportsCAS ?? false;
  const supportsLongPoll = o.supportsLongPoll ?? true;
  const supportsSinceTimeoutOverride = o.supportsSinceTimeoutOverride ?? false;
  const supportsCacheApi = o.supportsCacheApi ?? false;
  const tenantPrefix = o.tenantPrefix ?? CONFORMANCE_TENANT;
  const bearerToken = o.bearerToken ?? CONFORMANCE_BEARER;
  const bodyArb = o.bodyArb ?? DEFAULT_BODY_ARB;
  const provisionTableAtSeq = o.provisionTableAtSeq;
  // `caseSensitiveKeys` reserved for future per-variant overrides;
  // not currently exercised because UUIDv7 ids are produced by the
  // server (lowercase hex by construction).
  void (o.caseSensitiveKeys ?? true);
  void supportsCacheApi; // referenced in the JSDoc only on this branch.
  void tenantPrefix; // verifier-side concern; no test asserts on the value.

  const doFetch = opts.fetch;
  const provisionTable = opts.provisionTable;

  /**
   * Mint a fresh table name and provision its `current.json` via the
   * call-site callback. Awaited by every test that writes; pure-read
   * cases (e.g. the "GET of missing _id" 404 test) can still call
   * `freshTable(...)` directly to skip the provisioning round-trip.
   */
  const mintTable = async (prefix: string): Promise<string> => {
    const table = freshTable(prefix);
    await provisionTable(table);
    return table;
  };

  const authedRequest = (
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Request => {
    const headers: Record<string, string> = {
      authorization: `Bearer ${bearerToken}`,
      ...extraHeaders,
    };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    // Provide a fresh AbortController-less Request — call sites that
    // need to abort wire their own `signal` via the optional extra
    // headers / a direct Request construction. Keeping the helper
    // signal-free avoids a stale-controller surprise across cases.
    return new Request(`${BASE}${path}`, init);
  };

  const postDoc = async (
    table: string,
    doc: DocumentData,
  ): Promise<{ readonly status: number; readonly id?: string; readonly body: unknown }> => {
    const res = await doFetch(authedRequest("POST", `/v1/c/${table}`, { doc }));
    const json = (await res.json().catch(() => undefined)) as { readonly _id?: string } | undefined;
    return { status: res.status, id: json?._id, body: json };
  };

  describe(`HTTP conformance — ${opts.name}`, () => {
    // ── Block 1: get/put round-trip ─────────────────────────────────
    describe("get/put round-trip", () => {
      fcTest.prop({ body: bodyArb })(
        "POST then GET returns the same doc body",
        async ({ body }) => {
          const table = await mintTable("rt");
          const postRes = await doFetch(authedRequest("POST", `/v1/c/${table}`, { doc: body }));
          expect(postRes.status).toBe(201);
          const posted = (await postRes.json()) as { readonly _id: string };
          expect(typeof posted._id).toBe("string");
          const getRes = await doFetch(authedRequest("GET", `/v1/c/${table}/${posted._id}`));
          expect(getRes.status).toBe(200);
          const { data } = (await getRes.json()) as { readonly data: DocumentData };
          // `_id` is server-assigned (UUIDv7); strip before comparing.
          const { _id: _stripped, ...rest } = data;
          void _stripped;
          expect(rest).toEqual(body);
        },
        // Each iteration does a fresh table provisioning + POST + GET.
        // Over Minio HTTP that's ~30-50 ms; 100 iterations × 3 round
        // trips comfortably exceeds the vitest default 5s timeout.
        // 30s leaves headroom for slow CI Minio. `pnpm test:randomize`
        // cranks `FC_NUM_RUNS` to 10000 — at that volume the same
        // iteration cost stretches to ~5-8 minutes, so honor the
        // project-wide timeout from `vitest.config.ts` when scaled up.
        process.env["FC_NUM_RUNS"] !== undefined && Number(process.env["FC_NUM_RUNS"]) > 1_000
          ? 600_000
          : 30_000,
      );

      test("GET of missing _id returns 404 with NotFound", async () => {
        const table = await mintTable("rt-missing");
        // Insert one row so the read is unambiguously a "no such id"
        // rather than a "no such table" path (which also 404s, but
        // the assertion's narrower this way).
        await postDoc(table, { seed: "x" });
        const res = await doFetch(authedRequest("GET", `/v1/c/${table}/never-existed`));
        expect(res.status).toBe(404);
        const env = (await res.json()) as ErrorEnvelope;
        expect(env.error?.code).toBe("NotFound");
      });

      test("PATCH of missing _id returns 404 with NotFound", async () => {
        const table = await mintTable("rt-patch-missing");
        // Seed one row so the manifest tree exists; the PATCH target
        // is a different (never-written) id so the 404 path fires
        // for "no such row" rather than "no such table".
        await postDoc(table, { seed: 1 });
        const res = await doFetch(
          authedRequest("PATCH", `/v1/c/${table}/never-existed`, { patch: { status: "x" } }),
        );
        expect(res.status).toBe(404);
        const env = (await res.json()) as ErrorEnvelope;
        expect(env.error?.code).toBe("NotFound");
      });

      test("POST > 1 MiB body returns 413 PayloadTooLarge", async () => {
        const table = await mintTable("rt-big");
        // 1 MiB + 1 bytes — exactly one byte over the cap so we
        // exercise the boundary, not a 5x-over sledgehammer.
        const oversized = "x".repeat((1 << 20) + 1);
        const res = await doFetch(
          authedRequest("POST", `/v1/c/${table}`, { doc: { blob: oversized } }),
        );
        expect(res.status).toBe(413);
        const env = (await res.json()) as ErrorEnvelope;
        expect(env.error?.code).toBe("PayloadTooLarge");
      });

      for (const fieldCount of [0, 1, 16, 256]) {
        test(`round-trip doc with ${fieldCount} fields`, async () => {
          const doc: DocumentData = {};
          for (let i = 0; i < fieldCount; i += 1) {
            doc[`f${i}`] = i;
          }
          const table = await mintTable("rt-pin");
          const ins = await postDoc(table, doc);
          expect(ins.status).toBe(201);
          const id = ins.id!;
          const res = await doFetch(authedRequest("GET", `/v1/c/${table}/${id}`));
          expect(res.status).toBe(200);
          const { data } = (await res.json()) as { readonly data: DocumentData };
          const { _id: _stripped, ...rest } = data;
          void _stripped;
          expect(rest).toEqual(doc);
        });
      }
    });

    // ── Block 2: CAS via If-Match — gated on supportsCAS ────────────
    //
    // The current router does NOT thread `If-Match` headers
    // through to `Storage.put({ ifMatch })`; see
    // `packages/server/src/http/router.ts:162-185`. PATCH against a
    // known id always lands. We keep the describe block compiled so
    // a future ticket that wires the header in can flip the default
    // and the assertions surface for free.
    describe.skipIf(!supportsCAS)("CAS — If-Match (PATCH)", () => {
      test("PATCH with current ETag succeeds and rotates ETag", async () => {
        // Smoke for the future plumbing — kept compiling so flipping
        // `supportsCAS:true` doesn't require resurrecting the block.
        const table = await mintTable("cas");
        const ins = await postDoc(table, { status: "open" });
        expect(ins.status).toBe(201);
        const id = ins.id!;
        const getOne = await doFetch(authedRequest("GET", `/v1/c/${table}/${id}`));
        const etag = getOne.headers.get("etag");
        expect(etag).not.toBeNull();
        const patch = await doFetch(
          authedRequest(
            "PATCH",
            `/v1/c/${table}/${id}`,
            { patch: { status: "closed" } },
            {
              "if-match": etag!,
            },
          ),
        );
        expect(patch.status).toBe(200);
        const newEtag = patch.headers.get("etag");
        expect(newEtag).not.toBeNull();
        expect(newEtag).not.toBe(etag);
      });
    });

    // ── Block 3: Conditional GET ────────────────────────────────────
    //
    // The router doesn't emit `ETag` response headers on GET today
    // (router.ts uses `c.json(...)` directly — no etag computation).
    // So the only invariant we can assert here is: a GET with an
    // `If-None-Match` header that the server can't match returns 200
    // with the body — i.e. the conditional header doesn't accidentally
    // short-circuit on the HTTP surface.
    describe("conditional GET — If-None-Match", () => {
      test("If-None-Match with a stale tag returns 200 + body", async () => {
        const table = await mintTable("cond");
        const ins = await postDoc(table, { v: 1 });
        const id = ins.id!;
        const res = await doFetch(
          authedRequest("GET", `/v1/c/${table}/${id}`, undefined, {
            "if-none-match": '"definitely-stale"',
          }),
        );
        // Per coord note 6: Node variants never 304 because the router
        // doesn't emit ETag. Workerd may 304 once ticket 27's cache
        // layer warms an entry — but only if the cached response
        // carried an etag in the first place, which it doesn't. Accept
        // either outcome; the load-bearing invariant is "no 5xx".
        expect([200, 304]).toContain(res.status);
        if (res.status === 200) {
          const { data } = (await res.json()) as { readonly data: { readonly v: number } };
          expect(data.v).toBe(1);
        }
      });
    });

    // ── Block 4: CAS via If-None-Match:"*" on POST ──────────────────
    //
    // Out of scope: ticket 25's POST surface does NOT accept
    // caller-supplied `_id`, so there's no "create-if-absent" CAS
    // analogue to test. See ticket 28 §7 ("Out of scope") for the
    // resurrection path.

    // ── Block 5: DELETE ─────────────────────────────────────────────
    describe("DELETE", () => {
      test("DELETE of an inserted doc returns 204 and a subsequent GET returns 404", async () => {
        const table = await mintTable("del");
        const ins = await postDoc(table, { gone: true });
        const id = ins.id!;
        const del = await doFetch(authedRequest("DELETE", `/v1/c/${table}/${id}`));
        expect(del.status).toBe(204);
        const get = await doFetch(authedRequest("GET", `/v1/c/${table}/${id}`));
        expect(get.status).toBe(404);
      });

      test("DELETE of a missing _id returns 404 (not idempotent at this layer)", async () => {
        const table = await mintTable("del-miss");
        // One real insert so the table's manifest tree is populated;
        // otherwise a never-written table 404s for a different reason
        // and the assertion's narrower this way.
        await postDoc(table, { seed: 1 });
        const res = await doFetch(authedRequest("DELETE", `/v1/c/${table}/never-existed`));
        expect(res.status).toBe(404);
        const env = (await res.json()) as ErrorEnvelope;
        expect(env.error?.code).toBe("NotFound");
      });
    });

    // ── Block 6: List + predicate ───────────────────────────────────
    describe("list + predicate", () => {
      test("GET /v1/c/:collection after three POSTs returns all three docs", async () => {
        const table = await mintTable("list");
        for (const doc of [{ n: 1 }, { n: 2 }, { n: 3 }]) {
          const res = await postDoc(table, doc);
          expect(res.status).toBe(201);
        }
        const res = await doFetch(authedRequest("GET", `/v1/c/${table}`));
        expect(res.status).toBe(200);
        const { data } = (await res.json()) as { readonly data: ReadonlyArray<{ n: number }> };
        expect(data.length).toBe(3);
        const ns = data.map((r) => r.n).toSorted((a, b) => a - b);
        expect(ns).toEqual([1, 2, 3]);
      });

      test("?where=<JSON predicate> filters the row set", async () => {
        const table = await mintTable("list-where");
        for (const doc of [
          { title: "a", status: "open" },
          { title: "b", status: "open" },
          { title: "c", status: "closed" },
        ]) {
          const res = await postDoc(table, doc);
          expect(res.status).toBe(201);
        }
        // `?where=` carries a wire-form predicate now. The HTTP
        // parser routes the JSON straight into `validateWire`; the
        // object-form is no longer accepted on the wire.
        const where = encodeURIComponent(
          JSON.stringify({ clauses: [{ op: "eq", field: "status", value: "open" }] }),
        );
        const res = await doFetch(authedRequest("GET", `/v1/c/${table}?where=${where}`));
        expect(res.status).toBe(200);
        const { data } = (await res.json()) as {
          readonly data: ReadonlyArray<{ readonly status: string }>;
        };
        expect(data.length).toBe(2);
        for (const row of data) {
          expect(row.status).toBe("open");
        }
      });

      test("?where=<malformed wire (missing clauses)> returns 400 with InvalidConfig", async () => {
        const table = freshTable("list-dollar");
        // Pre-redesign agents zero-shot `{ $or: 1 }`; post-redesign
        // the wire validator rejects anything without a `clauses`
        // array.
        const where = encodeURIComponent(JSON.stringify({ $or: 1 }));
        const res = await doFetch(authedRequest("GET", `/v1/c/${table}?where=${where}`));
        expect(res.status).toBe(400);
        const env = (await res.json()) as ErrorEnvelope;
        expect(env.error?.code).toBe("InvalidConfig");
      });

      test("?where=<wire keying on _id> returns 400 with InvalidConfig and the by-id-verb redirect message", async () => {
        // Wire-validator depth-0 `_id` reject — agents zero-shot
        // writing the ceremony shape against the list route get
        // pointed at `GET /v1/c/:collection/:id`. Shape-agnostic (HTTP
        // status + body substring only).
        const table = freshTable("list-id-keyed");
        const where = encodeURIComponent(
          JSON.stringify({ clauses: [{ op: "eq", field: "_id", value: "x" }] }),
        );
        const res = await doFetch(authedRequest("GET", `/v1/c/${table}?where=${where}`));
        expect(res.status).toBe(400);
        const env = (await res.json()) as ErrorEnvelope;
        expect(env.error?.code).toBe("InvalidConfig");
        expect(env.error?.message ?? "").toContain('Predicates may not key on "_id"');
      });

      test("?where=<malformed JSON> returns 400 with SchemaError", async () => {
        const table = freshTable("list-bad");
        const res = await doFetch(authedRequest("GET", `/v1/c/${table}?where=notjson`));
        expect(res.status).toBe(400);
        const env = (await res.json()) as ErrorEnvelope;
        expect(env.error?.code).toBe("SchemaError");
      });

      test("?order=<JSON spec> sorts the row set", async () => {
        const table = await mintTable("list-order");
        for (const doc of [{ n: 3 }, { n: 1 }, { n: 2 }]) {
          const res = await postDoc(table, doc);
          expect(res.status).toBe(201);
        }
        const order = encodeURIComponent(JSON.stringify({ n: "asc" }));
        const res = await doFetch(authedRequest("GET", `/v1/c/${table}?order=${order}`));
        expect(res.status).toBe(200);
        const { data } = (await res.json()) as { readonly data: ReadonlyArray<{ n: number }> };
        expect(data.map((r) => r.n)).toEqual([1, 2, 3]);

        const orderDesc = encodeURIComponent(JSON.stringify({ n: "desc" }));
        const resDesc = await doFetch(authedRequest("GET", `/v1/c/${table}?order=${orderDesc}`));
        expect(resDesc.status).toBe(200);
        const { data: dataDesc } = (await resDesc.json()) as {
          readonly data: ReadonlyArray<{ n: number }>;
        };
        expect(dataDesc.map((r) => r.n)).toEqual([3, 2, 1]);
      });

      test("?order=<malformed JSON> returns 400 with SchemaError", async () => {
        const table = freshTable("list-order-bad");
        const res = await doFetch(authedRequest("GET", `/v1/c/${table}?order=notjson`));
        expect(res.status).toBe(400);
        const env = (await res.json()) as ErrorEnvelope;
        expect(env.error?.code).toBe("SchemaError");
      });

      test("?limit=<n> caps the row set", async () => {
        const table = await mintTable("list-limit");
        for (const doc of [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }, { n: 5 }]) {
          const res = await postDoc(table, doc);
          expect(res.status).toBe(201);
        }
        const res = await doFetch(authedRequest("GET", `/v1/c/${table}?limit=2`));
        expect(res.status).toBe(200);
        const { data } = (await res.json()) as { readonly data: ReadonlyArray<{ n: number }> };
        expect(data.length).toBe(2);
      });

      test("?limit=<non-integer> returns 400 with SchemaError", async () => {
        const table = freshTable("list-limit-bad");
        const res = await doFetch(authedRequest("GET", `/v1/c/${table}?limit=foo`));
        expect(res.status).toBe(400);
        const env = (await res.json()) as ErrorEnvelope;
        expect(env.error?.code).toBe("SchemaError");
      });
    });

    // ── Block 7: Encoding fidelity ─────────────────────────────────
    describe("GET /v1/count", () => {
      test("returns scalar { count: N } for the matching row set", async () => {
        const table = await mintTable("count");
        for (const doc of [{ s: "open" }, { s: "open" }, { s: "closed" }]) {
          const res = await postDoc(table, doc);
          expect(res.status).toBe(201);
        }
        const allRes = await doFetch(authedRequest("GET", `/v1/count?collection=${table}`));
        expect(allRes.status).toBe(200);
        const allBody = (await allRes.json()) as { readonly data: { readonly count: number } };
        expect(allBody.data.count).toBe(3);

        const where = encodeURIComponent(
          JSON.stringify({ clauses: [{ op: "eq", field: "s", value: "open" }] }),
        );
        const filteredRes = await doFetch(
          authedRequest("GET", `/v1/count?collection=${table}&where=${where}`),
        );
        expect(filteredRes.status).toBe(200);
        const filteredBody = (await filteredRes.json()) as {
          readonly data: { readonly count: number };
        };
        expect(filteredBody.data.count).toBe(2);
      });

      test("without ?collection= returns 400 with SchemaError", async () => {
        const res = await doFetch(authedRequest("GET", `/v1/count`));
        expect(res.status).toBe(400);
        const env = (await res.json()) as ErrorEnvelope;
        expect(env.error?.code).toBe("SchemaError");
      });
    });

    describe("PUT replace", () => {
      test("PUT /v1/c/:collection/:id with { doc } overwrites — omitted fields are dropped", async () => {
        const table = await mintTable("put-replace");
        const ins = await postDoc(table, { title: "old", tag: "a", count: 1 });
        expect(ins.status).toBe(201);
        const id = ins.id!;
        // Whole-doc PUT: only `title` survives, `tag`/`count` are dropped.
        const putRes = await doFetch(
          authedRequest("PUT", `/v1/c/${table}/${id}`, { doc: { title: "new" } }),
        );
        expect(putRes.status).toBe(200);
        const putBody = (await putRes.json()) as { readonly modified?: number };
        expect(putBody.modified).toBe(1);
        const getRes = await doFetch(authedRequest("GET", `/v1/c/${table}/${id}`));
        expect(getRes.status).toBe(200);
        const { data } = (await getRes.json()) as { readonly data: Record<string, unknown> };
        const { _id: _stripped, ...rest } = data;
        void _stripped;
        // Contrast with PATCH/merge-patch: omitted keys would have
        // been preserved. PUT must drop them.
        expect(rest).toEqual({ title: "new" });
      });

      test("PUT on missing _id returns 404 with NotFound", async () => {
        const table = await mintTable("put-404");
        const res = await doFetch(
          authedRequest("PUT", `/v1/c/${table}/no-such-row`, { doc: { x: 1 } }),
        );
        expect(res.status).toBe(404);
        const env = (await res.json()) as ErrorEnvelope;
        expect(env.error?.code).toBe("NotFound");
      });

      test("PUT without { doc } in body returns 400 with SchemaError", async () => {
        const table = await mintTable("put-bad");
        const ins = await postDoc(table, { x: 1 });
        const id = ins.id!;
        const res = await doFetch(
          authedRequest("PUT", `/v1/c/${table}/${id}`, { patch: { x: 2 } }),
        );
        expect(res.status).toBe(400);
        const env = (await res.json()) as ErrorEnvelope;
        expect(env.error?.code).toBe("SchemaError");
      });
    });

    describe("encoding fidelity", () => {
      test("UTF-8 multibyte fields round-trip through POST → GET", async () => {
        const doc: DocumentData = {
          greeting: "héllo🌍",
          // Family-with-ZWJ-sequence: the canonical pathological case
          // for a JSON serializer that re-encodes high surrogates.
          family: "👨‍👩‍👧‍👦",
          ascii: "plain",
        };
        const table = await mintTable("utf8");
        const ins = await postDoc(table, doc);
        expect(ins.status).toBe(201);
        const id = ins.id!;
        const res = await doFetch(authedRequest("GET", `/v1/c/${table}/${id}`));
        expect(res.status).toBe(200);
        const { data } = (await res.json()) as { readonly data: DocumentData };
        const { _id: _stripped, ...rest } = data;
        void _stripped;
        expect(rest).toEqual(doc);
      });

      test("base64-encoded byte field round-trips byte-for-byte", async () => {
        const b64 = bytesToBase64(PNG_FIXTURE);
        const table = await mintTable("bytes");
        const ins = await postDoc(table, { png: b64 });
        expect(ins.status).toBe(201);
        const id = ins.id!;
        const res = await doFetch(authedRequest("GET", `/v1/c/${table}/${id}`));
        expect(res.status).toBe(200);
        const { data } = (await res.json()) as { readonly data: { readonly png: string } };
        expect(typeof data.png).toBe("string");
        const round = base64ToBytes(data.png);
        expect(bytesEqual(round, PNG_FIXTURE)).toBe(true);
      });
    });

    // ── Block 8: AbortSignal ───────────────────────────────────────
    describe.skipIf(!supportsAbort)("AbortSignal", () => {
      test("pre-aborted signal on a GET rejects the fetch", async () => {
        const ac = new AbortController();
        ac.abort();
        const req = new Request(`${BASE}/v1/c/preabort/x`, {
          method: "GET",
          headers: { authorization: `Bearer ${bearerToken}` },
          signal: ac.signal,
        });
        // Different runtimes throw different concrete error types
        // (DOMException AbortError on Workerd, AbortError on Node).
        // Use a try/catch instead of `rejects.toBeDefined()` so we
        // explicitly observe the rejection and don't leave a dangling
        // unhandled-rejection on Workerd (where the SELF.fetch wrapper
        // surfaces the AbortError as an additional emission).
        let threw = false;
        try {
          await doFetch(req);
        } catch {
          threw = true;
        }
        expect(threw).toBe(true);
      });
    });

    // ── Block 9: Auth ──────────────────────────────────────────────
    describe("auth", () => {
      test("request without Authorization header returns 401 Unauthorized", async () => {
        const res = await doFetch(new Request(`${BASE}/v1/c/auth-missing`, { method: "GET" }));
        expect(res.status).toBe(401);
        const env = (await res.json()) as ErrorEnvelope;
        expect(env.error?.code).toBe("Unauthorized");
      });

      test("request with an invalid bearer token returns 401 Unauthorized", async () => {
        const res = await doFetch(
          new Request(`${BASE}/v1/c/auth-bad`, {
            method: "GET",
            headers: { authorization: "Bearer wrong" },
          }),
        );
        expect(res.status).toBe(401);
        const env = (await res.json()) as ErrorEnvelope;
        expect(env.error?.code).toBe("Unauthorized");
      });
    });

    // ── Block 10: Long-poll /v1/since ───────────────────────────────
    describe.skipIf(!supportsLongPoll)("long-poll /v1/since", () => {
      test("GET /v1/since after an insert returns the event in the response (fast path)", async () => {
        // Provision and write FIRST so the long-poll fast-path
        // returns immediately with the new event. The "empty cursor
        // + no events" path waits the full 25s default budget and
        // is intentionally not tested here — the cascade gives the
        // wait-then-receive case its own test below.
        const table = await mintTable("lp-fast");
        const ins = await postDoc(table, { fast: true });
        expect(ins.status).toBe(201);
        // Empty cursor → starts from `log_seq_start`. The first
        // insert is strictly greater than `log_seq_start=0`, so
        // `listEventsSince` returns it on the very first poll.
        const res = await doFetch(authedRequest("GET", `/v1/since?collection=${table}&cursor=`));
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          readonly events: ReadonlyArray<{ readonly op?: string }>;
          readonly next_cursor: string;
        };
        expect(body.events.length).toBeGreaterThanOrEqual(1);
        expect(typeof body.next_cursor).toBe("string");
        expect(body.next_cursor.length).toBeGreaterThan(0);
      });

      test("a doc insert that lands after the long-poll arms surfaces in the response", async () => {
        const table = await mintTable("lp-insert");
        // First write also populates the log, but the long-poll cursor
        // will skip past it — we race the second write against the
        // already-armed poll.
        await postDoc(table, { seed: 1 });
        // Open the long-poll. Use a short-enough timeout that the
        // suite never sits on the 25s default budget; the server's
        // poll-interval is 1s but we drive a write within ~50ms.
        const longPoll = doFetch(authedRequest("GET", `/v1/since?collection=${table}&cursor=`));
        // Race a write against the open long-poll. Wait one tick to
        // let the listener actually register before sending the POST.
        await new Promise((r) => setTimeout(r, 50));
        const ins = await postDoc(table, { surfaced: true });
        expect(ins.status).toBe(201);
        const res = await longPoll;
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          readonly events: ReadonlyArray<{ readonly op?: string }>;
          readonly next_cursor: string;
        };
        expect(body.events.length).toBeGreaterThanOrEqual(1);
        // At least one event records an insert ("I") op.
        expect(body.events.some((e) => e.op === "I")).toBe(true);
      });

      test("malformed cursor returns 400 SchemaError", async () => {
        const table = freshTable("lp-bad");
        const res = await doFetch(
          authedRequest("GET", `/v1/since?collection=${table}&cursor=not-an-lsn`),
        );
        expect(res.status).toBe(400);
        const env = (await res.json()) as ErrorEnvelope;
        expect(env.error?.code).toBe("SchemaError");
      });

      // Idle-poll wire shape: with no writes between two back-to-back
      // polls, the second poll MUST return `{events: [], next_cursor:
      // <same as first>}`. Gated on `supportsSinceTimeoutOverride`
      // because the default 25s budget would time the test out;
      // call sites that plumb a short `sinceTimeoutMs` opt in.
      test.skipIf(!supportsSinceTimeoutOverride)(
        "idle long-poll returns {events: [], next_cursor: <stable>} after the timeout",
        async () => {
          const table = await mintTable("lp-idle");
          // Drain the log first. An empty cursor means "from
          // log_seq_start"; with no writes since provisioning, the
          // first poll already times out idle. Capture its cursor —
          // that's our stable reference.
          const first = await doFetch(
            authedRequest("GET", `/v1/since?collection=${table}&cursor=`),
          );
          expect(first.status).toBe(200);
          const firstBody = (await first.json()) as {
            readonly events: ReadonlyArray<unknown>;
            readonly next_cursor: string;
          };
          expect(firstBody.events).toEqual([]);
          // Second poll feeds the first cursor back. No writes in
          // between, so the cursor MUST NOT move.
          const second = await doFetch(
            authedRequest(
              "GET",
              `/v1/since?collection=${table}&cursor=${encodeURIComponent(firstBody.next_cursor)}`,
            ),
          );
          expect(second.status).toBe(200);
          const secondBody = (await second.json()) as {
            readonly events: ReadonlyArray<unknown>;
            readonly next_cursor: string;
          };
          expect(secondBody.events).toEqual([]);
          expect(secondBody.next_cursor).toBe(firstBody.next_cursor);
        },
      );
    });

    // ── Block 10b: /v1/since cursor overflow regression ────────────
    //
    // Regression for the seq-segment overflow bug: at the old COUNT_BIT_WIDTH=10
    // the 1025th write to one collection produced countKey(1024) === "-1",
    // which LSN_RE rejected with a SchemaError (400) on the next poll,
    // permanently killing the change feed for that collection.
    //
    // This block does NOT sit inside the long-poll gate — /v1/since is
    // exercised on its fast-path (pre-existing events), which works on
    // every variant regardless of long-poll support. The test inserts
    // exactly 1025 documents so that next_seq reaches 1025 and the last
    // log entry carries seq = 1024 — one past the old 10-bit limit of
    // 1023. With the old encoding countKey(1024) returned "-1" (outside
    // [0-9a-v]), which LSN_RE rejected on the second poll.
    //
    // The unit-level overflow regression in packages/protocol/src/log.test.ts
    // verifies the encoding fix in isolation; this block confirms the fix
    // propagates end-to-end through the HTTP wire.
    describe("/v1/since cursor overflow regression (seq > 1023)", () => {
      test("cursor emitted after advancing past seq 1023 round-trips without SchemaError", async () => {
        // Strategy depends on whether the call site supplied
        // `provisionTableAtSeq` (a seam that lets us pre-seed
        // next_seq / log_seq_start directly):
        //
        //   a) With the seam (fast path): provision the collection at
        //      seq=1024 and insert exactly ONE document. The single write
        //      lands at seq=1024 — past the old 10-bit limit of 1023.
        //      Only one HTTP round-trip needed. All backends.
        //
        //   b) Without the seam (slow path): insert 1025 documents
        //      sequentially so next_seq reaches 1025. Suitable only for
        //      backends with cheap in-process storage (memory). Backends
        //      with real I/O should supply `provisionTableAtSeq`.
        //
        // Either path ends with a cursor whose seq segment must be 11 chars
        // (Math.ceil(53/5)) — the widened fixed width. With the old 10-bit
        // encoding, countKey(1024) produced "-1" and the server's LSN_RE
        // validator rejected it with 400 SchemaError.

        let seqTable: string;
        let cursor: string;

        if (provisionTableAtSeq !== undefined) {
          // ── Fast path: pre-seed next_seq=1024, log_seq_start=1024 ──
          // The kernel treats seqs 0..1023 as already snapshotted.
          // One insert lands at seq=1024.
          seqTable = freshTable("overflow-fast");
          await provisionTableAtSeq(seqTable, 1024);

          const ins = await postDoc(seqTable, { overflow: true });
          expect(ins.status).toBe(201);

          // Single poll: the one insert at seq=1024 is the only event.
          const res1 = await doFetch(
            authedRequest("GET", `/v1/since?collection=${seqTable}&cursor=`),
          );
          expect(res1.status).toBe(200);
          const body1 = (await res1.json()) as {
            readonly events: ReadonlyArray<unknown>;
            readonly next_cursor: string;
          };
          expect(body1.events).toHaveLength(1);
          cursor = body1.next_cursor;
        } else {
          // ── Slow path: 1025 sequential inserts ─────────────────────
          seqTable = await mintTable("overflow-1025");
          for (let i = 0; i < 1025; i += 1) {
            const ins = await postDoc(seqTable, { i });
            expect(ins.status).toBe(201);
          }

          // Drain all 1025 events; DEFAULT_MAX_EVENTS=1024 caps each
          // response, so two polls are needed to reach seq=1024.
          let cur = "";
          let lastCur: string | undefined;
          let iters = 0;
          do {
            const drainRes = await doFetch(
              authedRequest(
                "GET",
                `/v1/since?collection=${seqTable}&cursor=${encodeURIComponent(cur)}`,
              ),
            );
            expect(drainRes.status).toBe(200);
            const drainBody = (await drainRes.json()) as {
              readonly events: ReadonlyArray<unknown>;
              readonly next_cursor: string;
            };
            lastCur = cur;
            cur = drainBody.next_cursor;
            iters += 1;
            expect(iters).toBeLessThan(100);
          } while (cur !== lastCur);
          cursor = cur;
        }

        // Either path: `cursor` is the LSN of the write at seq=1024.
        // Its seq segment (third `_`-delimited token) must be 11 chars —
        // Math.ceil(COUNT_BIT_WIDTH/5) where COUNT_BIT_WIDTH=53. With the
        // old 10-bit encoding countKey(1024) returned "-1" (outside
        // [0-9a-v]), which LSN_RE rejected with 400 SchemaError.
        expect(typeof cursor).toBe("string");
        expect(cursor.length).toBeGreaterThan(0);
        const seqSegment = cursor.split("_")[2];
        expect(seqSegment).toBeDefined();
        // Concrete 11 — not imported — so this assertion doesn't tautologise.
        expect(seqSegment!.length).toBe(11);

        // Round-trip: feed the cursor back to /v1/since. With the old
        // encoding this returned 400 SchemaError; after the fix it must
        // return 200 with no new events (nothing written since drain).
        const res2 = await doFetch(
          authedRequest(
            "GET",
            `/v1/since?collection=${seqTable}&cursor=${encodeURIComponent(cursor)}`,
          ),
        );
        expect(res2.status).toBe(200);
        const body2 = (await res2.json()) as {
          readonly events: ReadonlyArray<unknown>;
          readonly next_cursor: string;
        };
        expect(body2.events).toHaveLength(0);
        expect(body2.next_cursor).toBe(cursor);
      }, 30_000);
    });

    // ── Block 11: read response `_meta` (ticket 33) ─────────────────
    //
    // The router emits `_meta.{manifest_pointer, fresh}` on
    // every successful read response (single-doc + list). Wire-level
    // tests can't surface `fresh:false` because each HTTP request
    // builds a fresh `Db` (the adapters mint one per request in
    // `worker.ts` / `server.ts`); the unit-level fresh:false case
    // lives in `packages/server/src/query.test.ts`. Here we verify
    // the shape, cursor stability across two no-writer reads, and
    // cursor advancement after a concurrent insert.
    describe("read response _meta", () => {
      type MetaBody = {
        readonly _meta: { readonly manifest_pointer: string; readonly fresh: boolean };
      };

      test("(a) cold read: fresh:true with a non-empty manifest_pointer", async () => {
        const table = await mintTable("meta-cold");
        const ins = await postDoc(table, { value: "v1" });
        const res = await doFetch(authedRequest("GET", `/v1/c/${table}/${ins.id!}`));
        expect(res.status).toBe(200);
        const body = (await res.json()) as MetaBody;
        expect(typeof body._meta.manifest_pointer).toBe("string");
        expect(body._meta.manifest_pointer.length).toBeGreaterThan(0);
        expect(body._meta.fresh).toBe(true);
      });

      test("(b) manifest_pointer is byte-stable across two reads with no writer in between", async () => {
        const table = await mintTable("meta-hot");
        const ins = await postDoc(table, { value: "v1" });
        const res1 = await doFetch(authedRequest("GET", `/v1/c/${table}/${ins.id!}`));
        const r1 = (await res1.json()) as MetaBody;
        const res2 = await doFetch(authedRequest("GET", `/v1/c/${table}/${ins.id!}`));
        const r2 = (await res2.json()) as MetaBody;
        expect(r2._meta.manifest_pointer).toBe(r1._meta.manifest_pointer);
      });

      test("(c) manifest_pointer advances + fresh:true after a concurrent writer commits", async () => {
        const table = await mintTable("meta-advance");
        await postDoc(table, { v: 1 });
        // Read through the LIST endpoint: the Workerd adapter's
        // Cache-API layer (`adapter-cloudflare/src/cache.ts`) busts
        // the list URL on every POST/PATCH/DELETE, so a second POST
        // forces the second read to re-anchor against the new
        // `current.json`. Reading a per-doc URL whose specific
        // `(table, id)` cache entry wasn't busted by the second POST
        // would re-serve the cached r1 envelope and the cursor would
        // not advance.
        const res1 = await doFetch(authedRequest("GET", `/v1/c/${table}`));
        const r1 = (await res1.json()) as MetaBody;
        // Concurrent writer bumps next_seq → pointer changes.
        await postDoc(table, { v: 2 });
        const res2 = await doFetch(authedRequest("GET", `/v1/c/${table}`));
        const r2 = (await res2.json()) as MetaBody;
        expect(r2._meta.manifest_pointer).not.toBe(r1._meta.manifest_pointer);
        expect(r2._meta.fresh).toBe(true);
      });
    });
  });
};
