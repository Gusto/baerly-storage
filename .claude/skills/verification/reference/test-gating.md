# Test gating

Which suites are gated behind Minio, credentials, Postgres, or Workerd, and
how the randomized cascade's four storage variants are wired.

`pnpm test` runs green on a fresh checkout with zero infrastructure
deps. Tests requiring Minio or credentials are gated by env:

- **Minio-required tests** (the `clock behavior` block of
  `tests/integration/time.test.ts`, and the `node-minio` variant of
  `tests/integration/randomized.test.ts`) skip by default. Run them
  with `MINIO=1 pnpm test` (alias: `pnpm test:minio`) after
  `pnpm dev:storage`.
- **`tests/integration/conformance.test.ts`** needs both Minio and
  credentials in `credentials/{aws,gcs,cloudflare}.json` (gitignored).
  Excluded from the default test glob. Run with `pnpm test:conformance`.
- **`tests/integration/export-smoke.test.ts`** needs a local Postgres
  on `127.0.0.1:5433` (provisioned by `pnpm dev:storage`). Excluded
  from the default test glob. Run with `pnpm test:export-smoke`.
- **`packages/adapter-cloudflare/src/r2-binding-storage.conformance.test.ts`**
  runs inside Workerd via the `cloudflare-pool` vitest project
  (`@cloudflare/vitest-pool-workers`, miniflare-backed). The R2
  binding `BUCKET` is wired in `vitest.config.ts` and re-published
  on `globalThis.__BAERLY_R2_BINDING__` by `tests/setup/r2-binding.ts`
  so the conformance factory can consume it. Excluded from the
  default project's glob; run with `pnpm test:adapter-cloudflare`
  (the script also sets `ADAPTER_CLOUDFLARE=1` for any future
  in-test conditionals). No external network, no credentials.
- **`packages/adapter-node/src/s3-http.conformance.test.ts`** runs
  against the same local Minio that `pnpm dev:storage` provisions.
  Gated by `MINIO=1` via `describe.runIf`; the bucket
  `baerly-conformance-adapter-node` is auto-created in the suite's
  `beforeAll` (409 BucketAlreadyOwnedByYou is tolerated). Run with
  `pnpm test:adapter-node`, or both adapter suites in sequence
  with `pnpm test:adapters`.
- **`tests/integration/collection-api.test.ts`** drives the locked
  `db.collection(...).{first,all,count,insert,update,replace,delete}`
  surface across three Node-side adapters
  (`memory`, `local-fs`, `node-minio`). `memory` + `local-fs` run by
  default; `node-minio` is gated on `MINIO=1` (via
  `pnpm test:minio`). The Workerd-side `cloudflare-r2` variant lives
  at `packages/adapter-cloudflare/src/collection-api.test.ts` and runs
  under the `cloudflare-pool` vitest project (via
  `pnpm test:adapter-cloudflare`). All variants share the
  backend-agnostic driver in `tests/fixtures/collection-api-cascade.ts`.
- **`tests/integration/maintenance-e2e.test.ts`** is the end-to-end
  durability gate: seeds 5000 entries, runs
  `runScheduledMaintenance` to quiescence, then asserts find()
  parity, bucket-object-count drop, `log_seq_start` advance, and the
  "< 1 Class A op / writer / hour" idle-reader cost-model bound via
  a hand-rolled counting `Storage` proxy. Runs `memory` + `local-fs`
  variants in the default project; `node-minio` and `cloudflare-r2`
  are deferred.

`randomized.test.ts` drives the all-to-all single-key causal-
consistency cascade through `Db` + `Writer` (from
`@baerly/server`) over four storage adapters:

- `memory` — `MemoryStorage`, shared per-bucket via
  `getOrCreateMemoryStorageForBucket`. Default project, no infra,
  runs in <1s on every PR.
- `local-fs` — `LocalFsStorage` over a fresh `mkdtemp` root.
  Default project, no infra, runs in ~1s on every PR.
- `cloudflare-r2` — `r2BindingStorage` over the miniflare R2 binding
  wired by `tests/setup/r2-binding.ts`. Lives at
  `packages/adapter-cloudflare/src/randomized.test.ts` and runs
  under the `cloudflare-pool` vitest project (Workerd). Excluded
  from the default glob; run with `pnpm test:adapter-cloudflare`.
- `node-minio` — `S3HttpStorage` against Toxiproxy → Minio with a
  fault-injection twiddler flipping the proxy every 100 ms. Default
  project, gated on `MINIO=1`; run with `pnpm test:minio`.

The cascade body is shared across projects via
`tests/fixtures/randomized-cascade.ts` (Node-import-free, so it loads
inside Workerd). The Node-side variant table is in
`tests/integration/randomized.test.ts`; the Workerd-side entry is in
`packages/adapter-cloudflare/src/randomized.test.ts`. Each variant
constructs N `Storage` handles sharing the same backing store, then
spins up N `Db` + `Writer` writers all contending on a single
collection log tail / next `log/<seq>` slot.

Pure-unit tests that always pass: `packages/protocol/src/hashing.test.ts`,
`tests/unit/consistency.test.ts`, `packages/protocol/src/xml.test.ts`,
`packages/protocol/src/json.test.ts`,
`packages/protocol/src/log.test.ts`,
`packages/protocol/src/storage/memory.test.ts`,
`packages/adapter-node/src/s3-http.test.ts`,
`packages/adapter-node/src/http-transport.test.ts`,
`packages/dev/src/local-fs.test.ts`,
`tests/unit/datatypes.test.ts`,
`tests/integration/bundle-size.test.ts`,
`tests/integration/log-emit.test.ts`,
`tests/integration/put-all-partial-failure.test.ts`,
`tests/integration/gc-restore-fencing.test.ts`,
`tests/integration/write-amp.test.ts`.
Pattern A/B/C drift across `examples/*/AGENTS.md` is fenced by
`tests/integration/agents-md-drift.test.ts`. The Node example servers'
storage-resolution guard (`examples/{minimal,react}-node/src/server/resolve-storage.ts`)
is unit-tested and kept byte-identical by
`tests/integration/node-storage-resolution.test.ts`.
