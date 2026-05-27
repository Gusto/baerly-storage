---
title: Client middleware
audience: integrator
summary: "Wrap the `fetch` option to add logging, retry, auth-refresh, and onSuccess/onError hooks without new API surface."
last-reviewed: 2026-05-18
tags: [client, middleware, integration]
related: ["./auth.md", "./observability.md", "./troubleshooting.md"]
---

# Client middleware

`baerly-storage/client` exposes one composable seam: the `fetch` option on
`BaerlyClientOptions`. Every HTTP request the client makes — table
reads, writes, the `since(...)` long-poll path — routes through that
one function. Cross-cutting concerns (logging, retry, tracing, auth
refresh) are user-side function composition rather than a new API.
This is structurally what tRPC sells as "links" and axios sells as
"interceptors" — same pattern, fewer concepts. The contract is one
line:

```ts
import { type Fetcher } from "baerly-storage/client";
// type Fetcher = (req: Request) => Promise<Response>;
```

`Fetcher` is exported from `baerly-storage/client` for use in your own
wrappers; every recipe below imports it from there.

## Hook callbacks: onSuccess / onError

Wrap the inner fetcher with a callback bag — one for the success
path, one for thrown errors. Useful when an observability layer
wants to react to outcomes without owning the request loop.

```ts
import { createBaerlyClient, type Fetcher } from "baerly-storage/client";

interface Hooks {
  readonly onSuccess?: (req: Request, res: Response) => void;
  readonly onError?: (req: Request, err: unknown) => void;
}

const withHooks =
  (next: Fetcher, hooks: Hooks): Fetcher =>
  async (req) => {
    try {
      const res = await next(req);
      hooks.onSuccess?.(req, res);
      return res;
    } catch (err) {
      hooks.onError?.(req, err);
      throw err;
    }
  };

const client = createBaerlyClient({
  baseUrl: "https://api.example.com",
  fetch: withHooks(globalThis.fetch, {
    onSuccess: (req, res) => log.info({ url: req.url, status: res.status }),
    onError: (req, err) => log.error({ url: req.url, err }),
  }),
});
```

`onSuccess` fires for **any** HTTP response that completes — 4xx and
5xx included, because those are not thrown exceptions. If you want
"2xx only", branch on `res.ok` inside the callback.

## Retry on transient failures

A wrapper that retries `GET` requests on 5xx with linear backoff.
Note the `req.clone()` before each call — a `Request` body is a
one-shot stream, and reusing the same `Request` across retries
exhausts it on the first attempt.

```ts
import { type Fetcher } from "@baerly/client";

const withRetry =
  (next: Fetcher, max = 3, baseMs = 100): Fetcher =>
  async (req) => {
    for (let i = 0; i < max - 1; i++) {
      const res = await next(req.clone());
      if (res.ok || res.status < 500 || req.method !== "GET") return res;
      await new Promise((r) => setTimeout(r, baseMs * (i + 1)));
    }
    return next(req);
  };
```

Only retry idempotent reads. `POST` / `PATCH` / `DELETE` may have
succeeded on the server even when the client sees a 5xx (commit
fence then network drop). The Baerly write path is CAS-guarded so a
duplicate write does not corrupt state — but it may surface as
`PreconditionFailed` to the application. Keep the
`req.method !== "GET"` guard.

## Refresh credentials on 401

This recipe composes with the `headers` option on
`BaerlyClientOptions`, which already accepts a function returning a
fresh header bag per call. The initial token comes from `headers`;
the wrapper below only kicks in if the server rejects the request
with `401`.

```ts
import { type Fetcher } from "@baerly/client";

const withAuthRefresh = (next: Fetcher, refresh: () => Promise<string>): Fetcher => {
  return async (req) => {
    const res = await next(req.clone());
    if (res.status !== 401) return res;
    const token = await refresh();
    const retried = new Request(req, {
      headers: new Headers({
        ...Object.fromEntries(req.headers),
        Authorization: `Bearer ${token}`,
      }),
    });
    return next(retried);
  };
};
```

Two layers, each doing one thing: `headers` mints the credential on
every request; `withAuthRefresh` re-mints it on rejection and
retries once. `Request` is immutable, so the retry needs
`new Request(req, ...)` to mint a fresh request with the new
`Authorization` header.

If the refreshed call also returns 401, this wrapper returns that
response unchanged — there is no second retry. That avoids an
infinite refresh loop when the refresh itself yielded a stale or
revoked token. Wire the next-stage handling (sign-out, prompt for
re-auth, surface the 401 to the UI) into the caller, not into this
wrapper.

Caveat: the `body` of a streaming `Request` is one-shot, so this
wrapper would fail on the retry for streaming uploads. The Baerly
client does not issue streaming bodies today (all writes are
buffered JSON), so this is a non-issue in practice — but worth
flagging if you reach for the pattern outside this context.

## Composition order

Wrappers compose as ordinary JavaScript functions: the outermost
wrapper sees the request first (on the way in) and the response
last (on the way out). The innermost wrapper is closest to the
network. Pick the order based on what you want to observe.

```ts
// Logger sees every retry attempt (up to 3 lines per failed call):
fetch: withRetry(withLogging(globalThis.fetch));

// Logger sees only the final outcome (1 line per call):
fetch: withLogging(withRetry(globalThis.fetch));
```

The same rule applies to `withHooks` + `withAuthRefresh`: if you put
hooks outside auth-refresh, `onSuccess` fires once per logical call
(after refresh has resolved); if hooks are inside, `onSuccess` fires
once per HTTP attempt (including the 401 that triggered the
refresh).

## Long-poll calls (`GET /v1/since`)

The long-poll path used by the React `useQuery` subscription pool
(via the internal `pollSinceOnce` helper) routes through the same
`Fetcher` — there is no separate transport. Retry, logging, and
auth-refresh wrappers apply uniformly. If your wrapper needs to
distinguish long-poll from one-shot reads (for example, to skip
retry on a request that already has a long server-side wait
budget), inspect `req.url` for `/v1/since` or a known query
parameter. Most wrappers do not need to.

## What this is not

Fetcher wrapping is **request-level** middleware. It sees `Request`
and `Response` objects — not typed query results, not the
`table().insert(...)` call shape. To intercept at the typed
query level (e.g. "log every `client.table('issues').insert(...)`
call"), wrap the client object instead:

```ts
import { createBaerlyClient, type BaerlyClient, type ClientTable } from "baerly-storage/client";
import type { DocumentData } from "baerly-storage";

const inner = createBaerlyClient({ baseUrl: "https://api.example.com" });

const traced: BaerlyClient = {
  ...inner,
  table: (name: string) => {
    const t = inner.table(name);
    const wrapped: ClientTable<DocumentData> = {
      ...t,
      insert: async (doc) => {
        console.log(`query: table(${name}).insert`, doc);
        return t.insert(doc);
      },
    };
    return wrapped;
  },
};
```

`first()` lives on `ClientQuery` (returned by `.where(...)`), not on
`ClientTable` — to trace the read path you would intercept `where`
and wrap the returned query. `insert` lives directly on
`ClientTable`, which keeps the example short.

Two different layers, two different mechanisms: fetcher wrapping for
HTTP-level concerns (status codes, retries, headers); client-object
wrapping for query-level concerns (which table, which method,
which arguments). Most apps need only the former.
