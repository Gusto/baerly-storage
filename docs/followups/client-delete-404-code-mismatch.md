# `ClientTable.delete()` 404 handler uses the wrong `code`

**Severity: MEDIUM. Bug surfaced during verification of E5
(abort-signal threading). The "swallow 404 on delete" branch
never fires.**

`packages/client/src/client.ts:440-443` catches errors from the
DELETE request and special-cases 404:

```ts
catch (err) {
  if (err.code === "Internal" && err.status === 404) {
    return { deleted: 0 };
  }
  throw err;
}
```

The intent — sensible — is "deleting a row that doesn't exist
isn't an error; return `{ deleted: 0 }`." The execution is broken:
the server returns `BaerlyError("NotFound", ...)` (see
`packages/server/src/http/router.ts:194`), which maps to
`error.code === "NotFound"`, not `"Internal"`.

Net effect: the catch branch never fires on a real server 404.
The "swallow 404" is dead code, and `delete(id)` on a missing id
throws a `NotFound` to the caller — exactly what the special case
was trying to prevent.

## Why the wrong code?

The analyst note (E18 in `next-batch.md`) flagged this as
"matching the request layer's synth, not the route's envelope."
That points at the underlying defect: somewhere between the route
and the client's `request` layer, a real server `NotFound`
envelope got re-coded to `"Internal"` once — and the catch arm
was written against that synthesised shape. Verify the request
layer's mapping is no longer doing that re-coding.

## Fix

Match the actual envelope:

```ts
catch (err) {
  if (err.code === "NotFound") {
    return { deleted: 0 };
  }
  throw err;
}
```

The `&& err.status === 404` check is also redundant — `code ===
"NotFound"` *is* the 404 in this protocol — but keeping it is
defensive in case the server ever multiplexes `NotFound` over
non-404 routes. Drop or keep per preference; the load-bearing fix
is the `code` string.

## Verify after fix

Add a regression test:

```ts
test("delete() on a missing id returns { deleted: 0 } without throwing", async () => {
  await expect(
    client.table("tickets").delete("ticket-that-never-existed")
  ).resolves.toEqual({ deleted: 0 });
});
```

Today (pre-fix) this test throws `BaerlyError("NotFound", ...)`.
Post-fix it resolves cleanly.

## Cross-references

- Sibling client wire bugs in `client-terminals-silently-lie.md`
  (E1/E2/E3) — same file, same review session.
- The request-layer mapping audit referenced above is a separate
  ticket if not already done — `packages/client/src/client.ts`'s
  HTTP wrapper should preserve server `code` end-to-end.
