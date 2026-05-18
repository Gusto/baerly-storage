# `http/since.ts`: replace the half-Storage stub, drop unset env knobs

**Severity: MEDIUM. No behaviour change in production.**

`packages/server/src/http/since.ts` carries two pieces of debt:

1. A half-implemented `Storage` adapter that exists so the
   `/v1/since` handler can borrow `Db._raw` for two GETs.
2. Two env-overridable timeout knobs that no template, example,
   or doc sets.

After this cleanup:

- `Db` exposes narrow `getCurrentJson(table)` / `getLogEntry(table, seq)`
  methods that `since.ts` uses directly. The half-`Storage` stub
  and the `eslint-disable no-underscore-dangle` header go away.
- `BAERLY_SINCE_TIMEOUT_MS` / `BAERLY_SINCE_POLL_INTERVAL_MS` env
  reads are dropped. The per-call `sinceTimeoutMs` /
  `sincePollIntervalMs` options stay — that's the contract callers
  actually use.

---

## 1. Replace `rawAsStorage` with two narrow `Db` methods

`packages/server/src/http/since.ts:1` opens with
`/* eslint-disable no-underscore-dangle */`. Lines 322-346 define
`rawAsStorage(db)`, which returns a one-method `Storage` (`get`
delegates to `db._raw.get`; `put`, `delete`, `list` all throw
`new BaerlyError("Internal", "rawAsStorage: <method> not supported")`).

The two real reads inside `since.ts`:

- `since.ts:258` — `readCurrentJson(rawAsStorage(db), currentJsonKey)`.
- `since.ts:298` — `db._raw.get(logEntryKey)`.

Both are tenant-aware lookups that `Db` already knows how to scope.

The `_raw` field on `Db` is a documented public-API escape hatch
(`packages/server/src/db.ts:1` lock comment,
`packages/server/src/db.ts:141-149` JSDoc + `@example`,
`packages/server/package.json:5` description). It has other
production consumers
(`tests/fixtures/randomized-cascade.ts:240` etc.). **This
workstream does not delete `_raw`**; it only removes the internal
half-stub built on top of it.

**Action:**

- Add `db.getCurrentJson(table): Promise<CurrentJsonBlob | null>`
  on `Db` (or whatever the existing internal type is).
- Add `db.getLogEntry(table, seq): Promise<LogEntry | null>` on
  `Db`.
- Both are tenant-scoped (they prepend the `Db`'s tenant prefix
  internally) and take only the public-visible scoping inputs.
- Switch `since.ts:258` to `db.getCurrentJson(table)` and
  `since.ts:298` to `db.getLogEntry(table, seq)`.
- Delete `rawAsStorage` (`since.ts:322-346`).
- Delete the `eslint-disable no-underscore-dangle` header
  (`since.ts:1`).
- Leave `Db._raw` alone — see "Out of scope" below.

---

## 2. Drop the `BAERLY_SINCE_*` env knobs

`packages/server/src/http/since.ts:76,83`:

```ts
const DEFAULT_TIMEOUT_MS       = Number(env.BAERLY_SINCE_TIMEOUT_MS ?? 25_000);
const DEFAULT_POLL_INTERVAL_MS = Number(env.BAERLY_SINCE_POLL_INTERVAL_MS ?? 1_000);
```

`grep -rn "BAERLY_SINCE_TIMEOUT_MS\|BAERLY_SINCE_POLL_INTERVAL_MS"`
across `examples/`, `manual-e2e/`, `docs/`, `wrangler.jsonc`, and
all `.env*` files returns zero setters. Only test fixtures and the
implementation itself reference them.

The per-call `sinceTimeoutMs` / `sincePollIntervalMs` options are
plumbed through both adapters
(`packages/adapter-node/src/baerly-node.ts:38-39,123-125`,
`packages/adapter-cloudflare/src/worker.ts:177-179,357-358`,
`packages/server/src/http/router.ts:79-81,107,362-363`) and are
already used by tests.

**Action:**

- Replace the two env lookups with literal defaults (`25_000`,
  `1_000`).
- Keep the per-call `sinceTimeoutMs` / `sincePollIntervalMs`
  options on `CreateRouterOptions` and the adapter options.
- Re-introduce env-var resolution if a real caller asks.

---

## Verification

After the workstream:

- `pnpm verify` — typecheck + lint pass.
- `pnpm test` — all default-project tests pass, including
  `tests/integration/since-options.test.ts` and
  `packages/server/src/http/since.test.ts`.
- `pnpm test:http-conformance` — the cascade still passes (it
  exercises the per-call overrides, not the env defaults).

## Out of scope

- `Db._raw`. It's a documented public escape hatch with non-test
  consumers; deletion is a public-API change tracked elsewhere
  (see the public-surface-audit workstream when it lands).
- `listEventsSince` / `longPollSince` export shape. Both are
  intentional public-surface entries for library users building
  their own `/since` endpoint; they have no repo-internal callers
  outside their own tests, but that's by design.
