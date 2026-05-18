# Router: collapse the error-response helpers

**Severity: LOW. No behaviour change. Pure clarity.**

`packages/server/src/http/router.ts` carries three helpers for
producing an error `Response` and a discriminated union for body-
parsing errors. The split was principled in spirit — `mapError`
for caught exceptions, `jsonError` for synthetic short-circuits —
but the two paths converge at `c.json(errorEnvelope(...), status)`,
and the discriminated union exists only to carry data that's
already derivable from `BaerlyErrorCode`.

After this cleanup: one error path. Handlers either throw a
`BaerlyError` or call `mapToResponse(c, new BaerlyError(code, msg))`.

---

## 1. Collapse `jsonError` into `mapToResponse`

`packages/server/src/http/router.ts:438` defines `mapError`:

```ts
export function mapError(err: unknown): { status: HttpStatus; envelope: HttpErrorEnvelope }
```

L454 defines `mapToResponse`:

```ts
function mapToResponse(c: Context, err: unknown): Response {
  const { status, envelope } = mapError(err);
  return c.json(envelope, status);
}
```

L466 defines `jsonError`:

```ts
function jsonError(c: Context, status: HttpStatus, code: BaerlyErrorCode, message: string): Response {
  return c.json(errorEnvelope(code, message), status);
}
```

10 `jsonError` callsites (router.ts:212, 230, 252, 279, 282, 298,
306, 313, 328, 348). All pass `(status, code, message)` triples
where `status` is derivable from `code` via the existing
`ERROR_TO_STATUS` map at router.ts:415-425.

6 `mapToResponse` callsites in `catch (e)` blocks (router.ts:239,
271, 290, 316, 331, 369).

**Action:**

- Delete `jsonError`.
- Rewrite the 10 callsites as `mapToResponse(c, new BaerlyError(code, msg))`.
- The `ERROR_TO_STATUS` map already maps `code → status` so
  `mapError` derives the status without the caller passing it.
- `mapError` is consumed externally by
  `packages/adapter-node/src/server.ts:25,293,364`
  (`createFetchHandler`) — keep it exported.

---

## 2. Replace `ReadJsonResult` with thrown `BaerlyError`

`packages/server/src/http/router.ts:492-499`:

```ts
type ReadJsonResult =
  | { readonly kind: "ok"; readonly value: unknown }
  | { readonly kind: "err";
      readonly code: "PayloadTooLarge" | "SchemaError";
      readonly status: HttpStatus;
      readonly message: string };
```

Two callers (POST at router.ts:278, PATCH at router.ts:297), each
shaped:

```ts
const body = await readJsonBody(c);
if (body.kind === "err") return jsonError(c, body.status, body.code, body.message);
```

The discriminated union carries `code`, `status`, and `message` —
but `status` is derivable from `code` (`ERROR_TO_STATUS`), and the
two error codes (`PayloadTooLarge`, `SchemaError`) are already
`BaerlyErrorCode` values that flow through `mapError`.

**Action:**

- Have `readJsonBody` throw `new BaerlyError("PayloadTooLarge",
  msg)` or `new BaerlyError("SchemaError", msg)` directly.
- Drop the `ReadJsonResult` type and the `kind === "err"` branch in
  both callsites.
- The router's existing `try/catch` around each route handler
  already routes thrown `BaerlyError`s through `mapToResponse`.
- Drop the `kind: "ok"` wrapper too — `readJsonBody` returns
  `unknown`.

---

## Verification

After the workstream:

- `pnpm verify` — typecheck + lint pass.
- `pnpm test` — all default-project tests pass, including
  `packages/server/src/http/router.test.ts`.
- `pnpm test:http-conformance` — the cascade still passes.
- Manual: confirm `mapError`'s external callsites in
  `packages/adapter-node/src/server.ts:25,293,364` continue to
  receive `{ status, envelope }` — the function shape doesn't
  change, only its callers inside `router.ts`.

## Out of scope

This workstream is purely the router-side error helpers and the
`ReadJsonResult` discriminated union. The router's options surface
(`verifier`/`healthCheck`/Mode B observability/`peekContext`) is
tracked in the prior router-options trim. The kernel-bundle
contents (dev-landing, `_raw` half-Storage stub, `since.ts` env
knobs) are tracked separately.
