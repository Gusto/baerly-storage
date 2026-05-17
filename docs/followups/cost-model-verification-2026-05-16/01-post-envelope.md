# 01 — Unify `POST /v1/t/:table` response envelope with the rest of the wire contract

**One-liner.** `POST /v1/t/:table` returns a bare `{"_id":"<id>"}` body
while every other success response wraps payload in `{"data": ..., "_meta": ...}`;
rewrite the wire shape to `{"data":{"_id":"<id>"}, "_meta": {...}}` and update
every in-repo consumer in lockstep.

## Estimated effort & risk

- **Effort:** 0.5–1.0 days. Mechanical: one server-side body construction,
  one client-side `request()` branch deletion, ~6 test-file updates,
  one type-doc comment, and a contract-table edit. No protocol-kernel
  changes.
- **Risk:** Low. The change is a pre-launch wire-contract rename
  with **no external users** (see `docs/contributing/conventions/change-discipline.md`
  — this repo has not launched and contracts can be changed freely).
  All consumers live in this repo; failure mode is a clean test
  failure, not silent data loss.

## Self-contained banner

This ticket is intentionally self-contained. **You do NOT need to read
`.claude/research/`** or any phase doc to implement it. The information
below — file paths, line ranges, current invariants, and step-by-step
edits — is the complete spec. Inputs are this file plus the repo
(`packages/`, `tests/`, `manual-e2e/`, `docs/`).

## Why we're doing this

baerly-storage's elevator pitch is "an LLM can use the public API
zero-shot from the `.d.ts` files alone" (see `CLAUDE.md` §"What this
is"). That promise relies on the wire contract being *uniform*: a
caller who already knows GET, PATCH, and the error envelope should not
need a special branch for POST.

Today the contract is:

| Route                      | Status | Body shape                                              |
|----------------------------|--------|---------------------------------------------------------|
| `GET    /v1/t/:t/:id`      | 200    | `{"data": {...}, "_meta": {"manifest_pointer":"...", "fresh": true}}` |
| `GET    /v1/t/:t`          | 200    | `{"data": [...], "_meta": {...}}`                       |
| **`POST   /v1/t/:t`**      | **201**| **`{"_id":"<id>"}`** — bare, no `data`, no `_meta`     |
| `PATCH  /v1/t/:t/:id`      | 200    | `{"data": {"modified": N}}`                             |
| `DELETE /v1/t/:t/:id`      | 204    | — (no body)                                             |
| any 4xx / 5xx              | 4xx/5xx| `{"error":{"code":"...","message":"...","issues":[...]?}}` |

The inconsistency forces every consumer (the SDK in
`packages/client/src/request.ts`, the conformance cascade in
`tests/fixtures/http-conformance-cascade.ts`, both adapter tests, and
the two `manual-e2e/` apps) to carry a `if (status === 201) return raw`
branch that has no analog for any other status. A new SDK author —
or an LLM zero-shotting against `contract.ts` — has to remember the
exception.

Since this is pre-launch (no published `1.x` API), the cheapest fix is
to **change the wire shape** rather than paper over it in the SDK.
After this ticket lands, a caller can use the *same* `(await
res.json()).data` unwrap on every success-status response, mirroring
the existing GET / PATCH path.

## Current state

All file paths are repo-relative.

### Server side: where the bare body is constructed

`packages/server/src/http/router.ts:253-270` — the POST handler:

```ts
// Insert — POST /v1/t/:table  Body: { doc }  → 201 { _id }
app.post("/v1/t/:table", async (c) => {
  const { table } = c.req.param();
  const body = await readJsonBody(c, MAX_BODY_BYTES);
  if (body.kind === "err") return jsonError(c, body.status, body.code, body.message);
  const { doc } = body.value as { doc?: unknown };
  if (doc === undefined || typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    return jsonError(c, 400, "SchemaError", "Request body must be { doc: object }");
  }
  try {
    const { _id } = await db
      .table(table)
      .insert(doc as Partial<JSONArraylessObject> & JSONArraylessObject);
    return c.json({ _id }, 201);                       // ← BARE BODY
  } catch (e) {
    return mapToResponse(c, e);
  }
});
```

Compare with the GET-one handler at `router.ts:198-219` which builds
`{ data: row, _meta: { manifest_pointer, fresh } } satisfies HttpOkEnvelope<JSONArraylessObject>`.
The POST handler does not call any envelope helper — it constructs
the body inline.

### Contract types and the status-code table

`packages/server/src/contract.ts:62-66` — the envelope type:

```ts
/** Successful single-doc / single-result wrapper. */
export interface HttpOkEnvelope<T> {
  readonly data: T;
  readonly _meta: HttpOkMeta;
}
```

`packages/server/src/contract.ts:107` — the status-code row currently
documents the legacy shape:

```
| 201    | `POST` insert success — body `{ _id }`.                          |
```

`packages/server/src/contract.ts:57-60` — `HttpOkMeta`:

```ts
export interface HttpOkMeta {
  readonly manifest_pointer: string;
  readonly fresh: boolean;
}
```

The router-level handler block-comment at `router.ts:82` repeats the
bare shape: `POST   /v1/t/:table → insert. Body: { doc }. → 201 { _id }.`

### Client side: where the SDK special-cases 201

`packages/client/src/request.ts:29-92` — the entire `request<T>()` body.
The 201 branch lives at lines 59-62:

```ts
// 201 Created — body is `{ _id }`, not `HttpOkEnvelope`. The only
// caller (`insert`) types T = `{ _id }` so we return the parsed
// body raw.
if (res.status === 201) return (await res.json()) as T;
```

The block-comment at lines 29-40 enumerates this as a special case
("- 201 → raw parsed body as T (POST insert success — body `{ _id }`).").
Lines 78-91 are the *general* 200 unwrap that we want 201 to share:

```ts
// 200 — for /v1/since the body is `SinceResponse` (no `data`
// unwrap); for everything else the body is `HttpOkEnvelope<T>`.
const body = (await res.json()) as unknown;
if (opts.path.startsWith("/v1/since")) {
  return body as T;
}
if (typeof body !== "object" || body === null || !("data" in body)) {
  throw new BaerlyClientError(
    "InvalidResponse",
    `Response to ${opts.method} ${opts.path} missing 'data' field`,
    res.status,
  );
}
return (body as HttpOkEnvelope<T>).data;
```

The single `insert()` caller at `packages/client/src/client.ts:225-227`
calls `request<{ _id: string }>(ctx, { method: "POST", ... })`. After
this ticket the type stays `{ _id: string }`; the server now wraps it
in `data` and `request()` does the unwrap.

### Tests that assert on the bare shape

Six call sites currently parse `res.json()` as `{ _id }`:

1. `tests/fixtures/http-conformance-cascade.ts:249` — the `postDoc`
   helper used by every block of the conformance cascade
   (`get/put round-trip`, `1 MiB body`, `index round-trip`, etc.).
   Reads `json?._id`.
2. `tests/fixtures/http-conformance-cascade.ts:262` — the property-
   based `POST then GET` body destructures `posted._id`.
3. `packages/client/src/client.test.ts:35-46` — the SDK unit test
   `table().insert() issues POST /v1/t/<name> with { doc } and unwraps { _id }`.
   The mocked POST handler returns `jsonResponse({ _id: "doc-1" }, 201)`.
4. `packages/adapter-node/src/server-routes.test.ts:106-125, 137-152,
   154-170, 274-286` — three `POST → GET` tests destructure
   `inserted._id` from `BaseEnvelope` (`{ _id?: string }`).
   `BaseEnvelope` itself is declared at lines 41-45.
5. `packages/adapter-cloudflare/src/worker-routes.test.ts:62-66`
   (`BaseEnvelope`), and lines 121-147, 172-204, 228-246, 263-287
   (three `POST → GET` paths and the `?where=` round-trip seeder).
6. `manual-e2e/cloudflare/e2e.test.ts:123` and
   `manual-e2e/node/e2e.test.ts:112` — the latency probes destructure
   `_id` from a raw `await post.json()`.

### Invariants that MUST survive this rewrite

- **Status code stays 201.** The Created status communicates
  "resource minted"; downgrading to 200 would lose that signal. The
  status-code table at `contract.ts:101-118` lists 201 as a first-
  class entry. Keep it.
- **`_id` stays exactly `_id` (literal underscore prefix).** The
  primary-key field name is locked across `Db`, `Table`, `Query`, the
  log entry shape, and every `eslint-disable no-underscore-dangle`
  comment in this repo. Do not rename to `id` here.
- **`_meta` shape must match GET.** Use the existing `HttpOkMeta`
  fields: `manifest_pointer: string` and `fresh: boolean`. Do not
  invent new fields.
- **No backwards-compat alias.** Per
  `docs/contributing/conventions/change-discipline.md` §"Backwards
  compatibility", do not dual-serve `{ _id }` and `{ data: { _id } }`.
  Update every caller in lockstep.

## Implementation steps

Execute in this order. Each step is a one-file edit unless noted.

### Step 1 — Rewrite the POST handler body shape

**File:** `packages/server/src/http/router.ts` (lines 253-270).

Replace the `return c.json({ _id }, 201);` line with an
`HttpOkEnvelope<{ _id: string }>` body that mirrors the GET-one
handler's shape. The handler does not have a `manifestPointer` /
`fresh` value from `insert()` (those come from the read path's
`runFirstWithMeta`), so we need to surface them from the writer.

There are two viable shapes for `_meta` on a POST response. Pick
**option A**:

- **Option A (recommended).** Surface the post-commit `manifest_pointer`
  the same way GET does. After `db.table(table).insert(...)` returns,
  call `db.tableReadContext(table)` to peek the freshly-committed
  pointer, then return:

  ```ts
  return c.json(
    {
      data: { _id },
      _meta: { manifest_pointer: pointer, fresh: true },
    } satisfies HttpOkEnvelope<{ _id: string }>,
    201,
  );
  ```

  `fresh: true` is correct: the row is, by definition, just written
  on this generation.

- **Option B.** Drop `_meta` from POST entirely (`HttpOkEnvelope`
  becomes optional on `_meta` for the 201 path). Rejected: breaks
  the type invariant that every successful response carries
  `_meta`, and makes the SDK's `request<T>` unwrap one branch
  shorter at the cost of the contract type telling a half-truth.

Go with option A. If the post-commit pointer plumbing is non-trivial
(it would require either exposing a `lastManifestPointer` getter on
`Db` / `Table.insert` or calling a separate `tableReadContext()` peek),
inline a *lazy* peek: invoke the read context once and reuse the same
`manifest_pointer` you'd return from a subsequent GET. The peek cost
is one bucket op (`current.json` HEAD) — already paid by the next
read — so it is acceptable here.

If after spelunking it turns out `Table.insert` already returns the
pointer in some result-shape (it currently returns just `{ _id }`),
extend the `Table.insert` return type to include the pointer and
thread it through. Do that work in this ticket; do not split it.

The block comment at `router.ts:82` also needs updating:

```ts
//  - `POST   /v1/t/:table` → insert. Body: `{ doc }`. → `201 { data: { _id }, _meta }`.
```

### Step 2 — Update the contract docstring and the status-code table

**File:** `packages/server/src/contract.ts`.

- Line 107 (the status-code table): change
  `| 201    | \`POST\` insert success — body \`{ _id }\`.                          |`
  to
  `| 201    | \`POST\` insert success — body \`HttpOkEnvelope<{ _id }>\`.        |`.

- Line 92 (the `Routes` union docstring for POST): change
  `/** Insert. Body: \`{ doc: JSONArraylessObject }\`. */`
  to add a `→` clause:
  `/** Insert. Body: \`{ doc: JSONArraylessObject }\`. → \`HttpOkEnvelope<{ _id }>\` | 4xx. */`.

### Step 3 — Collapse the SDK's 201 special case

**File:** `packages/client/src/request.ts` (lines 41-92).

Delete the 201 early-return at lines 59-62 entirely:

```ts
// 201 Created — body is `{ _id }`, not `HttpOkEnvelope`. The only
// caller (`insert`) types T = `{ _id }` so we return the parsed
// body raw.
if (res.status === 201) return (await res.json()) as T;
```

Update the block-comment at lines 29-40 to remove the
`- 201 → raw parsed body as T (POST insert success — body \`{ _id }\`).`
bullet. The remaining `200` general unwrap at lines 78-91 will now
also serve 201 — but verify the `res.ok` check on line 65 lets 201
fall through (`Response.ok` is `true` for 200-299, so 201 is fine).

After deletion the SDK has one unwrap rule for every 2xx-with-body
response: `(body as HttpOkEnvelope<T>).data`. No type changes needed
in `client.ts` — `insert()` still types `T = { _id }`.

### Step 4 — Update the conformance cascade fixtures

**File:** `tests/fixtures/http-conformance-cascade.ts`.

- Line 249 — the `postDoc` helper currently parses
  `(await res.json().catch(() => undefined)) as { readonly _id?: string }`.
  Change to:

  ```ts
  const json = (await res.json().catch(() => undefined)) as
    | { readonly data?: { readonly _id?: string } }
    | undefined;
  return { status: res.status, id: json?.data?._id, body: json };
  ```

- Line 262 — replace
  `const posted = (await postRes.json()) as { readonly _id: string };`
  with
  `const posted = (await postRes.json()) as { readonly data: { readonly _id: string } };`
  and update the subsequent `posted._id` → `posted.data._id`.

The other call sites in this file use the `postDoc` helper, so once
the helper is fixed they need no edit.

### Step 5 — Update the SDK unit test

**File:** `packages/client/src/client.test.ts` (lines 35-47).

Change the mocked POST handler response from
`return jsonResponse({ _id: "doc-1" }, 201);`
to
`return jsonResponse({ data: { _id: "doc-1" }, _meta: { manifest_pointer: "test", fresh: true } }, 201);`.

The assertion that follows (`expect(_id).toBe("doc-1")`) does not need
to change — it asserts on the SDK's *return value*, which is still
`{ _id }` after the unwrap. The change is purely on the *mocked wire
response* the test seeds.

### Step 6 — Update the adapter-node route tests

**File:** `packages/adapter-node/src/server-routes.test.ts`.

- Lines 41-45 — the `BaseEnvelope` type currently mixes `_id` at the
  top level with `data`. Rewrite to:

  ```ts
  interface BaseEnvelope {
    readonly error?: { readonly code: string; readonly message: string };
    readonly data?: { readonly _id?: string } | unknown;
  }
  ```

- Lines 115-117 (POST → GET round-trip): replace
  ```ts
  const inserted = (await insertRes.json()) as BaseEnvelope;
  expect(typeof inserted._id).toBe("string");
  const id = inserted._id!;
  ```
  with
  ```ts
  const inserted = (await insertRes.json()) as { data: { _id: string } };
  expect(typeof inserted.data._id).toBe("string");
  const id = inserted.data._id;
  ```

- Lines 142, 162, 275-280 — same pattern. The destructure
  `const { _id: id } = (await insertRes.json()) as BaseEnvelope;`
  becomes
  `const { data: { _id: id } } = (await insertRes.json()) as { data: { _id: string } };`.

### Step 7 — Update the adapter-cloudflare worker-routes tests

**File:** `packages/adapter-cloudflare/src/worker-routes.test.ts`.

Same edits as step 6 applied to the Workerd-side tests. Affected
lines: 62-66 (`BaseEnvelope`), 133-135, 191-193, 246, 280-287 (the
`for (const ticket of …)` seeder loop that posts three docs and
checks `res.status`).

The seeder loop at lines 270-287 only asserts on `status === 201`,
not on the body — leave it as is for that loop's iteration but tighten
the destructure pattern where the body IS read.

### Step 8 — Update the manual-e2e probes

**Files:** `manual-e2e/cloudflare/e2e.test.ts` and
`manual-e2e/node/e2e.test.ts`.

- `manual-e2e/cloudflare/e2e.test.ts:123` — replace
  `const { _id: id } = (await post.json()) as { readonly _id: string };`
  with
  `const { data: { _id: id } } = (await post.json()) as { readonly data: { readonly _id: string } };`.

- `manual-e2e/node/e2e.test.ts:112` — same edit.

These tests are gated on environment variables (`CF_DEPLOY_URL` etc.)
and don't run on `main`'s default test pass — but they're part of the
manual deploy-validation surface and must stay in sync. See
`manual-e2e/README.md` for the lifecycle.

### Step 9 — Sweep for stragglers

Run this grep from the repo root after steps 1-8:

```sh
grep -rnE '\bas \{ ?readonly _id\b|\b\(await [a-zA-Z]+\.json\(\)\) as \{ _id\b' \
  packages tests manual-e2e examples 2>/dev/null | grep -v node_modules | grep -v dist
```

Zero hits expected. Any survivors are direct parses of a POST
response that this ticket missed; fix them with the same destructure
swap.

### Step 10 — Confirm no doc shows the old shape

```sh
grep -rn '201.*{ ?_id ?}\|POST.*\b_id\b' docs/ 2>/dev/null
```

At the time of writing this returns no hits (verified during ticket
authoring). If hits appear, edit the docs to show
`{"data":{"_id":"<id>"}, "_meta":{...}}`.

## Conventions to follow

These are pulled forward from `CLAUDE.md` and
`docs/contributing/conventions/`; do not link out.

- **Imports are relative with explicit `.ts` extensions.** Inside
  `packages/server/src/` write
  `import { ... } from "./contract.ts"`; for cross-package types write
  `import { ... } from "@baerly/protocol"`. The strip-types runtime
  cannot resolve extensionless specifiers. Enforced by oxlint's
  `import/extensions` rule.
- **Branded types stay branded.** `_id` is typed `string` on the wire
  but as `Ref` in the kernel. Do not widen by writing
  `as string` to silence tsgo; if you hit a type error, surface it in
  the response shape, not in a cast.
- **Errors are `BaerlyError`.** The POST handler already catches and
  routes through `mapToResponse(c, e)` (router.ts:267) — that branch
  needs no change; it already returns the locked
  `HttpErrorEnvelope` shape via `mapError`.
- **No new dependencies.** This work is wire-shape only. No package
  additions.
- **No `.skip` / `.todo`.** If a test breaks after your edit, fix the
  test or the code; do not skip.
- **Pre-launch posture: no compat shims.** Per
  `docs/contributing/conventions/change-discipline.md` §"Backwards
  compatibility", change the contract and update all callers. Do not
  emit both shapes "for one release."
- **JSDoc with `@example`.** If you extend `Table.insert`'s return
  type in step 1 to include `manifest_pointer`, add a JSDoc
  `@example` on the new field per the rule in `CLAUDE.md` §"Public
  API docs".

## Verification

Run from the worktree root. Each command's expected outcome is
listed; if anything diverges, that's the failure to investigate.

### Typecheck + lint

```sh
pnpm verify
```

Expected: exit 0. Catches any missed `as { _id }` patterns at the
type level (the type widens away from `{ _id }` to
`{ data: { _id } }` only on the wire — the SDK return type is
unchanged).

### Default test pass (memory + local-fs)

```sh
pnpm test
```

Expected: exit 0. The `http-conformance-cascade` fixture runs under
both `memory` and `local-fs` variants in this glob.

### HTTP conformance suite specifically

```sh
pnpm test:http-conformance
```

Expected: exit 0. This is the focused gate — the file
`tests/integration/http-conformance.test.ts` plus the schema-bound
test block at lines 268-343.

### Cloudflare adapter under Workerd

```sh
pnpm test:adapter-cloudflare
```

Expected: exit 0. Catches the `worker-routes.test.ts` edits from
step 7 and the `cloudflare-r2` variant of the conformance cascade.

### Node adapter against Minio

```sh
pnpm dev:storage     # if not already running
pnpm test:adapter-node
```

Expected: exit 0. Catches the `server-routes.test.ts` edits from
step 6 and the `node-minio` variant of the conformance cascade.

### Manual smoke against curl

Spin up the helpdesk example with `pnpm dev:storage` running and an
adapter listening, then:

```sh
# BEFORE this ticket:
curl -sS -X POST http://localhost:8787/v1/t/tickets \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $SHARED_SECRET" \
  -d '{"doc":{"title":"hi"}}'
# {"_id":"01HXYZ..."}

# AFTER this ticket:
curl -sS -X POST http://localhost:8787/v1/t/tickets \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $SHARED_SECRET" \
  -d '{"doc":{"title":"hi"}}'
# {"data":{"_id":"01HXYZ..."},"_meta":{"manifest_pointer":"...","fresh":true}}
```

The before/after diff is the proof of the wire-shape change. Drop
this snippet into the PR description.

### Self-containment grep (used by ticket authors, not part of CI)

This file should not link to `.claude/research/`:

```sh
grep -nE "\]\([^)]*\.claude/research" \
  .claude/research/planning/tickets/cost-model-verification-followups/01-post-response-envelope.md
```

Expected: zero hits.

## Out of scope

The following items are *intentionally deferred* and do not block this
ticket. Each names where it lives.

- **PUT response envelope.** No PUT route exists in the locked
  contract (see `contract.ts:86-98` — only GET / POST / PATCH /
  DELETE / `/v1/since`). If PUT is added later, the same envelope
  rule applies; this ticket pre-fixes the convention.
- **`SinceResponse` envelope.** `/v1/since` deliberately does NOT
  wrap in `data` — the cursor-and-events shape is its own contract
  and the SDK's `request()` already short-circuits it
  (`packages/client/src/request.ts:80-83`). Leave that branch alone.
- **`manifest_pointer` semantics for POST.** This ticket surfaces it
  as the post-commit pointer (step 1, option A). A future ticket
  may tighten the contract to "the pointer at which a strong
  read will see this row" — same value today, but worth pinning in
  `docs/spec/sync-protocol.md` if/when long-poll cursors get richer.
- **Renaming `_id` to `id`.** Not happening. The leading underscore
  is the locked discriminant against user-supplied fields; see
  every `eslint-disable no-underscore-dangle` comment in
  `packages/client/`, `tests/`, and `manual-e2e/`.
- **Touching `Db.create({...}).table(...).insert()` Node-side
  return shape.** If step 1 chose option A's "peek the read
  context" path, `Table.insert` keeps its current `Promise<{ _id }>`
  type; the pointer is fetched ad-hoc in the HTTP handler. If a
  future read-after-write optimization wants the pointer threaded
  directly, that's a separate ticket on `Db` / `Table`.

## Pointers

Repo paths with line numbers. External URLs are deliberately absent —
everything you need is in this repo.

- **Locked status-code policy** —
  `packages/server/src/contract.ts:101-118`.
- **`HttpOkEnvelope<T>` type** —
  `packages/server/src/contract.ts:62-66`.
- **`HttpOkMeta`** —
  `packages/server/src/contract.ts:57-60`.
- **POST handler (the body to rewrite)** —
  `packages/server/src/http/router.ts:253-270`.
- **GET handler (the envelope shape to mirror)** —
  `packages/server/src/http/router.ts:198-219`.
- **SDK `request<T>()` (the branch to delete)** —
  `packages/client/src/request.ts:59-62` and surrounding context
  at lines 29-92.
- **SDK `Table.insert` caller** —
  `packages/client/src/client.ts:225-227`.
- **Conformance cascade `postDoc` helper** —
  `tests/fixtures/http-conformance-cascade.ts:244-251`.
- **Conformance cascade POST-then-GET property test** —
  `tests/fixtures/http-conformance-cascade.ts:256-282`.
- **SDK unit test** —
  `packages/client/src/client.test.ts:35-47`.
- **Adapter-node route tests** —
  `packages/adapter-node/src/server-routes.test.ts:41-45`
  (`BaseEnvelope`), 106-125 (POST→GET round-trip), 137-152
  (PATCH path), 154-170 (DELETE path), 274-286 (`?where=` seeder).
- **Adapter-cloudflare worker-routes tests** —
  `packages/adapter-cloudflare/src/worker-routes.test.ts:62-66`
  (`BaseEnvelope`), 121-147 (single-tenant dev verifier),
  172-204 (POST→GET round-trip), 228-246 (DELETE path),
  263-299 (`?where=` test).
- **Manual-e2e latency probes** —
  `manual-e2e/cloudflare/e2e.test.ts:118-130` and
  `manual-e2e/node/e2e.test.ts:108-118`.
- **Change-discipline ("no compat aliases")** —
  `docs/contributing/conventions/change-discipline.md:24-34`.
- **Test conventions (do not skip)** —
  `docs/contributing/conventions/tests.md` (read before adding tests).
- **Public-API JSDoc convention** —
  `CLAUDE.md` §"Conventions" → "Public API docs live as JSDoc".
