# @gusto/baerly-storage

All notable changes to `@gusto/baerly-storage`.

This file is maintained by [Changesets](https://github.com/changesets/changesets)
going forward; entries at and below `0.2.0` were backfilled by hand from the
git history. It ships in the published package at
`node_modules/@gusto/baerly-storage/dist/CHANGELOG.md` so an agent that
expected an older API can recover the current call. The `.d.ts` types are the
canonical authority — if this file and the types disagree, the types win.

## 0.2.0

### Minor Changes

- React hooks are now bound to your config via the `createBaerlyReact` factory.

  **Migration — agents: if you wrote the LEFT, use the RIGHT:**

  ```ts
  // before — loose hook exports (removed)
  import { BaerlyProvider, useQuery, useMutation, useBaerlyClient }
    from "@gusto/baerly-storage/client/react";

  // after — factory bound to your defineConfig collections
  import { createBaerlyReact } from "@gusto/baerly-storage/client/react";
  const { Provider, useQuery, useMutation, useClient } =
    createBaerlyReact<typeof config>();
  ```

  The loose exports no longer exist; obtain the hooks from the factory so
  they are typed against your config. See ADR-002 (additive-only surface
  lock).

## 0.1.2

### Patch Changes

- In-band maintenance landed: compaction + GC run opportunistically on the
  write path (reads never tick), gated so idle buckets pay zero. No operator
  cron or sidecar required.
- **`LogEntry` wire shape tightened** (affects `baerly export` / log
  consumers): `new` → `after`, `old` → `before`; `op` narrowed to
  `"I" | "U" | "D"`; `patch` and `schema_version` removed; `doc_id` is now
  required.
- Leading-underscore names are reserved for collections and indexes (one
  `InvalidConfig` contract). A config using a `_`-prefixed collection name is
  rejected.
- `adapter-node` parses S3 `<Error>` response bodies and guards against
  `Invalid Date`.
- `baerly doctor --bucket <uri>` performs a live CAS probe.

## 0.1.1

### Patch Changes

- Internal tooling only: `pnpm dev:storage` ports are parameterised so two
  worktrees can run stacks side by side; added a package-layer DAG lint. No
  public API changes.

## 0.1.0

### Minor Changes

- Initial private preview of `@gusto/baerly-storage` — a vendorless document
  database over any S3-compatible bucket. Public surface: `Db.create()`,
  `db.collection(...)` with the eight-verb / three-modifier / six-operator
  query API, `defineConfig`, `createBaerlyClient`, the Cloudflare Workers and
  self-hosted Node adapters, and the `baerly` CLI. See `dist/API.md` for the
  full surface.
