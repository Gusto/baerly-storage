# Followups: error codes + type ergonomics

**Source: 2026-05-19 analyst triage (A9, A13, A14).** All three
items are validated against current code as of triage. Each is
local to one file and small in blast radius — good early wins.

---

## 1. A9. `Db.create` requires pre-flattened `BaerlyConfig.collections`

**Severity: MEDIUM. DX tax for app-code construction.**

`defineConfig` returns
`{ collections: { name: { schema, indexes } } }`. `Db.create`
won't accept that shape — it demands `schemas: Map<string,
SchemaValidator>` and `indexes: Map<string, IndexDefinition[]>`
already flattened. The adapter code does this; app code that
constructs `Db` directly has to repeat the boilerplate.

The JSDoc literally says "the adapter layer (or app code)
flattens" — the library is making the user pay tax to keep `Db`
"library-agnostic" for a use case nobody has.

**Fix:** Make `Db.create` accept `BaerlyConfig["collections"]`
directly and flatten internally. One shape, one path. Remove
the per-adapter flatten code; adapter calls become a single
`Db.create({ storage, collections: cfg.collections, ... })`.

Verify: the flatten logic in `packages/adapter-node/` and
`packages/adapter-cloudflare/` is byte-equal; if it has diverged,
fold both into the new internal flatten.

---

## 2. A13. `BaerlyErrorCode.OfflineNoCache` has no producer

**Severity: MEDIUM. Dead error code on the public discriminant.**

`packages/protocol/src/errors.ts:9-10` documents `OfflineNoCache`
as "Read attempted while `online: false`" but no `online` flag
exists anywhere in the codebase. The HTTP-dispatcher's
`default → 500` arm lists the code in its mapping but never
receives it.

**Fix (two parts):**

1. Delete `OfflineNoCache` from `BaerlyErrorCode`. Remove the
   mapping arm. Verify no docs reference it.
2. While in `errors.ts`: audit `Internal`. Per the brief, it's
   overused as "shouldn't happen" where `InvalidResponse` would
   be more truthful. Document each remaining code's current
   producer site as a one-line JSDoc comment beside the union
   member — makes the surface readable in IDE hover.

---

## 3. A14. `BaerlyClientError` duplicates `BaerlyError` for no win

**Severity: MEDIUM. Forces two `instanceof` checks for one
logical thing.**

`packages/client/src/errors.ts` defines `BaerlyClientError`,
identical to `BaerlyError` plus a `status: number` field. The
comment claims "a future `@baerly/react-query` wrapper" — pure
speculation; no such consumer exists.

Real downside: callers can't write one `instanceof BaerlyError`
check across server-side and client-side code paths. Zero call
sites today use `instanceof BaerlyClientError`.

**Fix:** Reuse `BaerlyError` everywhere. Put `status` on the
`cause` chain or in a context bag. One error class, one `code`
discriminant. Update client code to throw `BaerlyError` directly.

Verify before deletion: grep `BaerlyClientError` across
`packages/client/`, `examples/`, and any `@baerly/react-query`-
adjacent surface in case the speculation materialised.
