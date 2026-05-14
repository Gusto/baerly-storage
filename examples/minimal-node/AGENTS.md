---
title: AGENTS.md — agent guidance for minimal-node
audience: agent
summary: How to develop and deploy minimal-node, a baerly app.
tags: [agent-entry, baerly]
---

# AGENTS.md

Guidance for AI coding agents working in this repo. This is a
baerly app — a vendorless document database that runs over any
S3-compatible storage API.

## What this is

`minimal-node` is a baerly app scaffolded with `create-baerly`.
The Node-side server lives in `apps/server/`; the optional client
lives in `apps/web/`. Configuration lives in `baerly.config.ts`.

Public API docs: https://docs.baerly.dev/ (the JSDoc on
`@baerly/server`'s `Db` and `Table` is the canonical reference;
read it via your editor's TS LS or via the published types).

## Toolchain

- **Package manager:** pnpm. The emitted repo pins
  `packageManager: pnpm@10.31.0`.
- **Test runner:** vitest.
- **Type checker:** TypeScript 5.6+. (The baerly-storage monorepo
  itself uses TypeScript 7 via `@typescript/native-preview`; this
  template tracks the broadly-compatible TS major so scaffolded
  apps work with the wider ecosystem.)

## Verification

| Command            | What it does                                       | Runtime          |
| ------------------ | -------------------------------------------------- | ---------------- |
| `pnpm typecheck` | TS typecheck across both apps                      | seconds          |
| `pnpm dev`       | Run the server locally — `tsx watch src/server.ts` | seconds to start |
| `pnpm test`        | Run all tests across both apps                     | seconds          |

## Where the code is

| Path                        | What it is                                          |
| --------------------------- | --------------------------------------------------- |
| `apps/server/src/server.ts` | Server entry — `createListener({ verifier })`       |
| `apps/server/Dockerfile`    | Multi-stage container build (distroless runtime, non-root)        |
| `apps/web/`                 | Optional client; SPA shell. Remove if not needed.   |
| `baerly.config.ts`          | App config — `app`, `tenant`, `target`, `domain`    |
| `.baerly/schema.lock.json`  | Declared collection schemas — see "Schemas (live feature)" below. |

## When editing X, read Y

- **Predicates** — `db.table<Doc>(name).where({...}).all()`. The
  predicate is exact-equality only on day one; top-level fields and
  dotted-path keys are supported. There are no operators (`$or`,
  `$gt`, `$in`, `$regex`). Calling `.where(...)` twice AND-merges:

  ```ts
  // Top-level equality
  await db.table("tickets").where({ status: "open" }).all();

  // Dotted-path on a nested field
  await db.table("tickets")
    .where({ "assignee.team": "platform" })
    .all();

  // AND-merge across two .where() calls
  await db.table("tickets")
    .where({ status: "open" })
    .where({ "assignee.team": "platform" })
    .all();
  ```

  The value type is JSON-arrayless: string / number / boolean / nested
  object. Arrays are intentionally not supported as predicate values;
  use `useIndex` (next bullet) for index-backed lookups.

- **Indexes (`useIndex`)** — opt-in hint for the read path to walk a
  secondary index instead of folding the snapshot + scanning the
  table. Single-field equality only today (the planner that
  auto-picks an index is future work). The reader still re-checks the
  predicate in memory, so a stale index never produces wrong rows —
  only at worst surfaces a row the predicate then drops.

  ```ts
  await db.table("tickets")
    .where({ status: "open" })
    .useIndex("by_status")
    .all();
  ```

  Declare indexes in `baerly.config.ts` via:

  ```ts
  import { defineConfig } from "@baerly/server";

  export default defineConfig({
    collections: {
      tickets: {
        indexes: [{ name: "by_status", on: "status" }],
      },
    },
  });
  ```

  The adapter threads `collections` into `Db.create({ ... })` for
  you. Mismatches (multi-field predicate or missing index) fall back
  to the full table scan with a metric bump — correctness is
  preserved.

- **Schemas (live feature)** — schemas are validated on the server
  for every `insert` / `update` / `replace` when bound. Declare via
  `defineConfig` using any StandardSchema v1 validator (Zod 3.24+,
  Valibot 0.36+, ArkType 2.0+, or anything implementing the spec):

  ```ts
  import { z } from "zod";
  import { defineConfig } from "@baerly/server";

  const Ticket = z.object({
    _id: z.string().optional(),
    status: z.enum(["open", "closed"]),
    title: z.string().min(1),
  });

  export default defineConfig({
    collections: {
      tickets: { schema: Ticket },
    },
  });
  ```

  On a validation failure the server throws
  `BaerlyError{ code: "SchemaError", issues: [{ path, message }] }`;
  HTTP clients see a 422 with the same envelope. Validation runs
  on the post-image so `update` and `replace` see the full doc, not
  just the patch.

  The companion `.baerly/schema.lock.json` carries an optional
  declarative form for tooling that wants a JSON view of the active
  schemas; an empty `{ "tables": {} }` is fine when you supply the
  schemas in code.

- **Auth setup (Node)** — `apps/server/src/server.ts` selects:

  1. `bearerJwt({ jwks, issuer, audience })` when `JWKS_URL` is set.
     The verifier fetches the JWKS, validates `iss` / `aud` /
     signature, and derives `tenantPrefix` from the `sub` claim by
     default.
  2. `sharedSecret({ secret, tenantPrefix })` when `SHARED_SECRET` is
     set. Use for `pnpm dev` parity only — production deployments
     should always set `JWKS_URL` and remove the shared-secret
     branch.

  **Production recipe (5 minutes):**

  1. Pick an IdP (Auth0, Okta, Cognito, Clerk, Workers Access,
     self-hosted Keycloak — anything that exposes a JWKS endpoint).
  2. Find the JWKS URL — usually `https://<issuer>/.well-known/jwks.json`.
  3. Set the env vars in `.env` (or your deploy environment):

     ```sh
     JWKS_URL=https://your-idp.example.com/.well-known/jwks.json
     JWT_ISSUER=https://your-idp.example.com/
     JWT_AUDIENCE=baerly-prod
     ```

  4. Restart the server. `baerly doctor --target=node` runs a 3s
     JWKS reachability probe; non-200 → warning.
  5. Remove the `SHARED_SECRET` branch from `server.ts` before going
     to prod (or set `SHARED_SECRET` to an unguessable value behind
     a feature flag).

- **Maintenance loop (Node)** — `apps/server/src/server.ts` calls
  `runMaintenanceTick({ storage, currentJsonKey })` on a 1-hour
  `setInterval` when `MAINTENANCE_KEY` is set. The tick is unbounded
  (`NODE_PROFILE`): one pass folds the entire live tail and sweeps
  up to 1000 candidates.

  No external scheduler required for the in-process loop. For
  systemd/k8s setups that prefer external timers, omit
  `MAINTENANCE_KEY` and invoke `runMaintenanceTick` from your
  systemd `OnCalendar=` unit or k8s `CronJob`.

  Maintenance emits one canonical info line per run on stdout.
  Filter your log stream on `"unit_of_work": "maintenance"` and
  read these fields:

  - `compact_written` — log entries folded into the new snapshot
    this tick (`0` when compact was skipped or the live tail was
    below `minEntriesToCompact`).
  - `gc_swept` — keys deleted this tick (`0` when GC was skipped
    or no candidates aged out).
  - `compact_skipped` / `gc_skipped` — `true` when the caller
    alternated this phase away (not used by the default Node
    interval, but available for custom schedulers that toggle).
  - The kernel also emits the recorder-bag fields alongside:
    `db.compact.entries_folded_p50` / `_p99` / `_count` / `_sum`,
    `db.manifest.lag_window_depth`, `db.orphan.candidate_count`,
    `db.gc.entries_swept_per_second`, `db.gc.swept_total_total`.
    Useful for dashboards; the four explicit fields above are
    the at-a-glance summary.

- **Deploy** — `baerly deploy --target=node` emits production
  artifacts into `apps/server/`: `Dockerfile`, `pm2.config.cjs`,
  `systemd/baerly.service`, `.dockerignore`, `healthcheck.js`, and
  `.env.example`. It does not push containers — build the image and
  hand it to your orchestrator (`docker build`, `pm2 start`,
  `systemctl enable`). `baerly deploy --target=node --force`
  overwrites hand-edits; `baerly doctor --target=node` is read-only
  and reports drift.

## Anti-patterns

- Widening branded types from `@baerly/protocol` (`Ref`,
  `ManifestKey`). The types prevent confusion bugs.
- Reaching into `node_modules/@baerly/protocol/src/` directly —
  consume the published exports.
- Mutating `VerifierResult.tenantPrefix` between the verifier
  and `Db.create`. The dispatcher pins the tenant from the
  verifier's return value.

## When to graduate

baerly is designed for the small-to-medium operating point. The cost
model puts the soft ceiling at:

- **~30 writes / minute / collection**
- **~10 GB / tenant**
- **~100 collections / tenant**

Past those, S3 list-prefix latency, manifest fold cost, and per-class
op pricing start to dominate; you're better off on a real database.
The graduation target is **D1** (or Postgres, or SQLite via Litestream
— pick what fits your runtime). At the M-size operating point, D1
costs roughly $5/month versus baerly's ~$19/month; the pitch is
portability, not cost.

**Estimate your current rate:** `baerly doctor --usage --target=...`
(upcoming) lists recent log entries per collection and computes
writes/min. Warning at 50% of the ceiling; export suggestion at
100%.

**Export when ready:** `baerly export --target=sqlite|postgres|d1
--bucket=<...> --app=<...> --tenant=<...> --table=<...>` writes a
canonical SQL dump (and a `<output>.plan.json` sidecar carrying the
inferred `ExportPlan`) that you load into your graduation target.
The export is point-in-time and honours the active schema. Flags:
`--where=<json-predicate>`, `--where-comment`, `--output`,
`--no-sidecar`, `--json`. Exit codes: 0 success, 1 InvalidConfig,
2 Storage/Network, 3 Protocol invariant.

## Pointers

- `baerly.config.ts` — app config.
- `apps/server/src/server.ts` — server entry.
- `apps/server/Dockerfile` — container build.
- `package.json` — root scripts + pnpm workspace.
