/* eslint-disable no-underscore-dangle -- `_id` is the locked
   primary-key field on document shapes (see `@baerly/protocol`'s
   `Table<T>` / `Query<T>` declarations); the cascade asserts it by
   name. */

/**
 * HTTP conformance cascade — backend-agnostic test driver.
 *
 * Mirrors `defineStorageConformanceSuite` from
 * `packages/protocol/src/storage/conformance.ts` but over the
 * Phase-6 HTTP wire instead of the in-process `Storage` interface.
 * Same describe-block organisation, same capability-flag policy, same
 * `beforeEach` reset pattern (each `freshTable(...)` minted in a test
 * body is its own namespace — table provisioning happens server-side
 * on first write through `ServerWriter.commit()`, so the test only
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
import type { JSONArraylessObject } from "@baerly/protocol";
import { CONFORMANCE_BEARER, CONFORMANCE_TENANT } from "./test-verifier";

/**
 * Capability flags + arbitrary overrides for the HTTP conformance
 * cascade. Defaults match what every Phase-6 adapter on this branch
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
   * When true, the conditional-GET block additionally exercises the
   * Cache API path (ticket 27): a second GET issued within the same
   * test run hits `caches.default` and still respects `If-None-Match`
   * → 304. Workerd-only: the Node listener has no `caches.default`.
   *
   * Even when `true`, the cascade tolerates a 200 fall-through: the
   * Phase-6 router does not emit `ETag` headers on the GET response
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
  readonly bodyArb?: fc.Arbitrary<JSONArraylessObject>;
}

export type HttpFetch = (req: Request) => Promise<Response>;

/**
 * Provision `current.json` for a (test-verifier tenant, app, table)
 * triple. The Phase-6 HTTP surface has no "create table" endpoint;
 * the underlying `ServerWriter.commit()` throws `InvalidResponse`
 * when `current.json` is missing. Production deployments provision
 * via `createCurrentJson()` at deploy time; tests need the same
 * step inside the runtime that owns the storage handle.
 *
 * Implementations call `createCurrentJson(storage, key, seed)` with
 * the bucket-relative key
 * `app/<app>/tenant/<tenant>/manifests/<table>/current.json`. The
 * `app`/`tenant` values come from the call site's listener wiring
 * (Node: passed to `createListener({ app, ... })`; Workerd: passed
 * through the worker module's env binding).
 */
export type ProvisionTable = (table: string) => Promise<void>;

/**
 * The route prefix is hard-coded in the locked Phase-6 contract
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
const DEFAULT_BODY_ARB: fc.Arbitrary<JSONArraylessObject> = fc.dictionary(
  fc.stringMatching(/^[a-z][a-z0-9_]{0,7}$/),
  fc.oneof(fc.string({ maxLength: 32 }), fc.integer(), fc.boolean()) as fc.Arbitrary<
    string | number | boolean
  >,
  { minKeys: 0, maxKeys: 6 },
) as unknown as fc.Arbitrary<JSONArraylessObject>;

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
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
};

/** Encode bytes as URL-safe base64 (atob/btoa exist in Node 24+ and Workerd). */
const bytesToBase64 = (bytes: Uint8Array): string => {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
};

const base64ToBytes = (b64: string): Uint8Array => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
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
  const supportsCacheApi = o.supportsCacheApi ?? false;
  const tenantPrefix = o.tenantPrefix ?? CONFORMANCE_TENANT;
  const bearerToken = o.bearerToken ?? CONFORMANCE_BEARER;
  const bodyArb = o.bodyArb ?? DEFAULT_BODY_ARB;
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
    doc: JSONArraylessObject,
  ): Promise<{ readonly status: number; readonly id?: string; readonly body: unknown }> => {
    const res = await doFetch(authedRequest("POST", `/v1/t/${table}`, { doc }));
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
          const postRes = await doFetch(authedRequest("POST", `/v1/t/${table}`, { doc: body }));
          expect(postRes.status).toBe(201);
          const posted = (await postRes.json()) as { readonly _id: string };
          expect(typeof posted._id).toBe("string");
          const getRes = await doFetch(authedRequest("GET", `/v1/t/${table}/${posted._id}`));
          expect(getRes.status).toBe(200);
          const { data } = (await getRes.json()) as { readonly data: JSONArraylessObject };
          // `_id` is server-assigned (UUIDv7); strip before comparing.
          const { _id: _stripped, ...rest } = data;
          void _stripped;
          expect(rest).toEqual(body);
        },
        // Each iteration does a fresh table provisioning + POST + GET.
        // Over Minio HTTP that's ~30-50 ms; 100 iterations × 3 round
        // trips comfortably exceeds the vitest default 5s timeout.
        // 30s leaves headroom for slow CI Minio.
        30_000,
      );

      test("GET of missing _id returns 404 with an error envelope", async () => {
        const table = await mintTable("rt-missing");
        // Insert one row so the read is unambiguously a "no such id"
        // rather than a "no such table" path (which also 404s, but
        // the assertion's narrower this way).
        await postDoc(table, { seed: "x" });
        const res = await doFetch(authedRequest("GET", `/v1/t/${table}/never-existed`));
        expect(res.status).toBe(404);
        const env = (await res.json()) as ErrorEnvelope;
        expect(env.error?.code).toBeDefined();
      });

      for (const fieldCount of [0, 1, 16, 256]) {
        test(`round-trip doc with ${fieldCount} fields`, async () => {
          const doc: JSONArraylessObject = {};
          for (let i = 0; i < fieldCount; i += 1) doc[`f${i}`] = i;
          const table = await mintTable("rt-pin");
          const ins = await postDoc(table, doc);
          expect(ins.status).toBe(201);
          const id = ins.id!;
          const res = await doFetch(authedRequest("GET", `/v1/t/${table}/${id}`));
          expect(res.status).toBe(200);
          const { data } = (await res.json()) as { readonly data: JSONArraylessObject };
          const { _id: _stripped, ...rest } = data;
          void _stripped;
          expect(rest).toEqual(doc);
        });
      }
    });

    // ── Block 2: CAS via If-Match — gated on supportsCAS ────────────
    //
    // The current Phase-6 router does NOT thread `If-Match` headers
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
        const getOne = await doFetch(authedRequest("GET", `/v1/t/${table}/${id}`));
        const etag = getOne.headers.get("etag");
        expect(etag).not.toBeNull();
        const patch = await doFetch(
          authedRequest(
            "PATCH",
            `/v1/t/${table}/${id}`,
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
    // short-circuit on the Phase-6 surface.
    describe("conditional GET — If-None-Match", () => {
      test("If-None-Match with a stale tag returns 200 + body", async () => {
        const table = await mintTable("cond");
        const ins = await postDoc(table, { v: 1 });
        const id = ins.id!;
        const res = await doFetch(
          authedRequest("GET", `/v1/t/${table}/${id}`, undefined, {
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
        const del = await doFetch(authedRequest("DELETE", `/v1/t/${table}/${id}`));
        expect(del.status).toBe(204);
        const get = await doFetch(authedRequest("GET", `/v1/t/${table}/${id}`));
        expect(get.status).toBe(404);
      });

      test("DELETE of a missing _id returns 404 (not idempotent at this layer)", async () => {
        const table = await mintTable("del-miss");
        // One real insert so the table's manifest tree is populated;
        // otherwise a never-written table 404s for a different reason
        // and the assertion's narrower this way.
        await postDoc(table, { seed: 1 });
        const res = await doFetch(authedRequest("DELETE", `/v1/t/${table}/never-existed`));
        expect(res.status).toBe(404);
        const env = (await res.json()) as ErrorEnvelope;
        expect(env.error?.code).toBeDefined();
      });
    });

    // ── Block 6: List + predicate ───────────────────────────────────
    describe("list + predicate", () => {
      test("GET /v1/t/:table after three POSTs returns all three docs", async () => {
        const table = await mintTable("list");
        for (const doc of [{ n: 1 }, { n: 2 }, { n: 3 }]) {
          const res = await postDoc(table, doc);
          expect(res.status).toBe(201);
        }
        const res = await doFetch(authedRequest("GET", `/v1/t/${table}`));
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
        const where = encodeURIComponent(JSON.stringify({ status: "open" }));
        const res = await doFetch(authedRequest("GET", `/v1/t/${table}?where=${where}`));
        expect(res.status).toBe(200);
        const { data } = (await res.json()) as {
          readonly data: ReadonlyArray<{ readonly status: string }>;
        };
        expect(data.length).toBe(2);
        for (const row of data) expect(row.status).toBe("open");
      });

      test("?where=<$-prefixed key> returns 400 with InvalidConfig", async () => {
        const table = freshTable("list-dollar");
        const where = encodeURIComponent(JSON.stringify({ $or: 1 }));
        const res = await doFetch(authedRequest("GET", `/v1/t/${table}?where=${where}`));
        expect(res.status).toBe(400);
        const env = (await res.json()) as ErrorEnvelope;
        expect(env.error?.code).toBe("InvalidConfig");
      });

      test("?where=<malformed JSON> returns 400 with SchemaError", async () => {
        const table = freshTable("list-bad");
        const res = await doFetch(authedRequest("GET", `/v1/t/${table}?where=notjson`));
        expect(res.status).toBe(400);
        const env = (await res.json()) as ErrorEnvelope;
        expect(env.error?.code).toBe("SchemaError");
      });
    });

    // ── Block 7: Encoding fidelity ─────────────────────────────────
    describe("encoding fidelity", () => {
      test("UTF-8 multibyte fields round-trip through POST → GET", async () => {
        const doc: JSONArraylessObject = {
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
        const res = await doFetch(authedRequest("GET", `/v1/t/${table}/${id}`));
        expect(res.status).toBe(200);
        const { data } = (await res.json()) as { readonly data: JSONArraylessObject };
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
        const res = await doFetch(authedRequest("GET", `/v1/t/${table}/${id}`));
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
        const req = new Request(`${BASE}/v1/t/preabort/x`, {
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
        const res = await doFetch(new Request(`${BASE}/v1/t/auth-missing`, { method: "GET" }));
        expect(res.status).toBe(401);
        const env = (await res.json()) as ErrorEnvelope;
        expect(env.error?.code).toBe("Unauthorized");
      });

      test("request with an invalid bearer token returns 401 Unauthorized", async () => {
        const res = await doFetch(
          new Request(`${BASE}/v1/t/auth-bad`, {
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
        const res = await doFetch(authedRequest("GET", `/v1/since?table=${table}&cursor=`));
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
        const longPoll = doFetch(authedRequest("GET", `/v1/since?table=${table}&cursor=`));
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
          authedRequest("GET", `/v1/since?table=${table}&cursor=not-an-lsn`),
        );
        expect(res.status).toBe(400);
        const env = (await res.json()) as ErrorEnvelope;
        expect(env.error?.code).toBe("SchemaError");
      });
    });

    // ── Block 11: read response `_meta` (ticket 33) ─────────────────
    //
    // The Phase-6 router emits `_meta.{manifest_pointer, fresh}` on
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
        const res = await doFetch(authedRequest("GET", `/v1/t/${table}/${ins.id!}`));
        expect(res.status).toBe(200);
        const body = (await res.json()) as MetaBody;
        expect(typeof body._meta.manifest_pointer).toBe("string");
        expect(body._meta.manifest_pointer.length).toBeGreaterThan(0);
        expect(body._meta.fresh).toBe(true);
      });

      test("(b) manifest_pointer is byte-stable across two reads with no writer in between", async () => {
        const table = await mintTable("meta-hot");
        const ins = await postDoc(table, { value: "v1" });
        const r1 = (await (
          await doFetch(authedRequest("GET", `/v1/t/${table}/${ins.id!}`))
        ).json()) as MetaBody;
        const r2 = (await (
          await doFetch(authedRequest("GET", `/v1/t/${table}/${ins.id!}`))
        ).json()) as MetaBody;
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
        const r1 = (await (
          await doFetch(authedRequest("GET", `/v1/t/${table}`))
        ).json()) as MetaBody;
        // Concurrent writer bumps next_seq → pointer changes.
        await postDoc(table, { v: 2 });
        const r2 = (await (
          await doFetch(authedRequest("GET", `/v1/t/${table}`))
        ).json()) as MetaBody;
        expect(r2._meta.manifest_pointer).not.toBe(r1._meta.manifest_pointer);
        expect(r2._meta.fresh).toBe(true);
      });
    });
  });
};
