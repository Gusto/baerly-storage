---
"@gusto/baerly-storage": minor
---

Adds the `BaerlyError{code:"CursorExpired"}` error code: HTTP 410, not retriable. `GET /v1/since` returns it for a cursor that can no longer resume, because the changes after it are no longer retained or because `baerly admin restore --force` truncated the generation it was minted in. Both used to be `SchemaError` (400), the same code as a form-validation failure. A malformed cursor is still `SchemaError` (400). The resolution is to re-read, then restart with `cursor: ""`; the changes between the dead cursor and the restart are not replayed.

The React subscription poll (`createBaerlyReact` / `useQuery`) now re-bootstraps on `CursorExpired` instead of `SchemaError`. A `SchemaError` from `/v1/since` now parks the poll like any other non-retriable code, until `refetch`.

**Migration — agents: if you wrote the LEFT, use the RIGHT:**

```ts
// before: a hand-rolled /v1/since consumer
if (res.status === 400 && body.error.code === "SchemaError" && cursor !== "") cursor = "";
// after
if (res.status === 410 && body.error.code === "CursorExpired") cursor = ""; // re-read your rows first
```

An exhaustive `switch` over `BaerlyErrorCode` needs a `CursorExpired` case.
