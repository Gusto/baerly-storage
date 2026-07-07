# @gusto/baerly-storage

## 0.5.0

### Minor Changes

- 5afe09a: Observability: coexist with a host app's LogTape config instead of clobbering it.

  baerly-storage is a library, and LogTape's guidance is that only the application
  configures LogTape. Previously the Node and Cloudflare adapters called
  `configure({ reset: true })` at boot unconditionally, which silently wiped
  the sinks and loggers of any app that had already configured LogTape (and,
  depending on boot order, could itself be wiped). The documented "leave the
  field unset to skip configuration" escape hatch never actually worked.

  Now:

  - `configureObservability` checks `getConfig()` first. When LogTape is
    already configured by something other than baerly-storage, it leaves that config
    intact and emits a single `["logtape", "meta"]` notice rather than
    resetting it. baerly-storage's own config is still reconfigured last-call-wins, so
    standalone servers and dev hot-reload are unchanged.
  - `baerlyNode` / `baerlyWorker` accept `observability: false` to skip
    auto-configuration entirely, for apps that own the process-wide
    (isolate-wide on Workers) LogTape configuration themselves.

### Patch Changes

- d94b57b: Rename the `/v1/spec` field `kernelVersion` → `serverVersion`.

  `kernelVersion` was a build-provenance stamp (= the published package
  version) whose name wrongly implied a separate "kernel" contract axis.
  `serverVersion` names it honestly. The value and meaning are unchanged,
  and `specVersion` stays `"1"`: the wire-contract axis is `specVersion`,
  and pre-consumer wire shape may change without bumping it (see
  `docs/contributing/conventions/versioning.md`).

  **Migration — agents: if you read the LEFT, read the RIGHT:**

      GET /v1/spec → { "specVersion": "1", "kernelVersion": "0.4.1", ... }   // before
      GET /v1/spec → { "specVersion": "1", "serverVersion": "0.4.1", ... }   // after

  Key contract decisions off `specVersion`, never off `serverVersion` — the
  latter is build provenance, equal to the package version.

## 0.4.1

### Patch Changes

- Stamp the correct kernelVersion into the served /v1/spec. 0.4.0 shipped kernelVersion "0.3.0" because changeset:version did not regenerate baerly.spec.json; gen:spec now runs on every bump.

## 0.4.0

### Minor Changes

- 878bd78: Fail closed on ephemeral storage in production

  `MemoryStorage` now refuses to construct in a detected deployment
  (`NODE_ENV=production` or a known PaaS marker) unless you explicitly acknowledge
  that it's ephemeral. This closes a silent-data-loss failure mode: an app that
  falls back to in-memory storage in production, where writes "succeed" into
  process RAM and vanish on every restart with no loud signal.

  **What changed**

  - `new MemoryStorage()` throws `BaerlyError("InvalidConfig")` in a detected
    deployment. Tests and local dev are unaffected — neither sets those signals.
  - New `resolveStorageFromEnv(env?)` export on `@gusto/baerly-storage/node`: the
    safe, tested storage selector the Node example scaffolds now use, so apps
    don't hand-roll one with a silent fallback.
  - New `assertStorageReachable(storage)` export on `@gusto/baerly-storage/node`:
    an opt-in boot/readiness check that fails closed on an unreachable or
    CAS-broken bucket — the wrong-bucket-name gap a missing-bucket guard can't
    catch.
  - New pure `isDeployedEnv(env)` predicate on `@gusto/baerly-storage`.

  **Migration**

  - To run in-memory storage in a deployment on purpose (e.g. a throwaway demo),
    opt in explicitly — either in code:

    ```ts
    new MemoryStorage({ ephemeral: true });
    ```

    or via the environment:

    ```sh
    BAERLY_ALLOW_EPHEMERAL_STORAGE=true
    ```

  - No action needed for tests, local dev, or apps already using a real S3/R2
    bucket.

  **Platform note**

  - The guard is effectively Node-only. A Cloudflare Worker requires an R2
    binding and has no silent in-memory fallback, and the deploy-detection
    predicate reads `process.env`, which is empty on Workerd — so the guard never
    fires (and never needs to) on Cloudflare.
  - CI is never treated as deployed. When `CI` is set to a non-empty, non-`false`
    value, PaaS-marker detection is suppressed, so `MemoryStorage` still
    constructs in CI — including Kubernetes-hosted CI agents that set
    `KUBERNETES_SERVICE_HOST`. An explicit `NODE_ENV=production` still trips the
    guard.

- ab1d80e: Node apps can now run with zero storage credentials, using the new
  `localFsStorage()` factory from `@gusto/baerly-storage/node`. The Node examples
  default to local filesystem storage in development and promote to S3 or R2 once
  bucket environment variables are set.

  `localFsStorage()` is a local-dev convenience only — single-process, with no
  cross-process CAS and no crash durability. So the Node example servers fail loud
  in a detected deployment (`NODE_ENV=production` or a known PaaS) and require a
  real bucket: a missing or typo'd bucket aborts startup instead of running
  production on non-durable storage. There is deliberately no opt-in to run
  local-fs in a deployment. When self-hosting without a cloud bucket, run MinIO on
  the box or use SQLite + Litestream.

- 7ded765: Cloudflare Workers can now talk to S3-compatible storage over HTTP instead of a
  native R2 binding. This is opt-in; the R2 binding remains the default.

  New exports and options:

  - New Worker-safe subpath `@gusto/baerly-storage/s3` exports `S3HttpStorage` and
    `sigV4Signer`. Their closure pulls in no `node:` builtins, so it loads in a
    Worker.
  - `baerlyWorker` accepts an optional `storage` in its factory options. It
    defaults to the `env.BUCKET` R2 binding.
  - `BaerlyEnv.BUCKET` is now optional, so an S3-only Worker need not declare an R2
    binding.

  `sigV4Signer` fails fast with `InvalidConfig` when `accessKeyId`,
  `secretAccessKey`, or `region` is empty or whitespace-only (for example, a blank
  or accidentally-spaced wrangler `var`). This replaces signing with blank
  credentials — or building a malformed empty-region SigV4 scope — and drawing an
  opaque 403.

  This path ships at the same support tier as AWS-via-`S3HttpStorage`:
  credential-gated, with production validation owned by the operator. CI guards the
  closure under workerd on two levels:

  - a bundle probe that it stays `node:`-free (so it loads in a Worker), and
  - an in-isolate wire test that `S3HttpStorage` + `sigV4Signer` actually run
    there — signing, XML parse, request/response plumbing — against an in-memory
    S3 stub.

  CI does not drive a real S3 endpoint from workerd. Verify yours with `baerly
doctor --bucket` before relying on it. Note that `baerly deploy` and `doctor
--target=cloudflare` still expect an R2 binding in `wrangler.jsonc`.

- df232a4: Add IRSA (web-identity) credential support for S3 on EKS. Previously
  `fromEksPodIdentity()` handled only the EKS Pod Identity agent
  (`AWS_CONTAINER_CREDENTIALS_FULL_URI`). Clusters that inject credentials via
  IRSA (`AWS_ROLE_ARN` + `AWS_WEB_IDENTITY_TOKEN_FILE`) threw `InvalidConfig` on
  first sign, so every S3 call failed.

  Two new credential providers in `@gusto/baerly-storage/node`:

  - `fromWebIdentity()` — exchanges the projected service-account token for
    short-lived credentials via STS `AssumeRoleWithWebIdentity`. The call is
    unsigned; the token is the auth. It returns `expiration`, so the signing layer
    rotates the ~1h credentials automatically. No AWS SDK dependency — it uses
    `fetch` plus the existing hardened XML parser.
  - `fromEks()` — auto-detects the mechanism on each resolve: Pod Identity when
    `AWS_CONTAINER_CREDENTIALS_FULL_URI` is present, otherwise IRSA. It throws a
    clear `InvalidConfig` when neither is configured. Prefer this over the
    mechanism-specific providers unless you have a reason to pin one.

  Both EKS providers now fail with actionable errors instead of a bare status. A
  missing, unreadable, or empty projected token throws `InvalidConfig`. A failed
  STS `AssumeRoleWithWebIdentity` call folds the STS error `Code`/`Message` (for
  example, `InvalidIdentityToken`) into the thrown message, so credential
  misconfigs are diagnosable at a glance.

  `fromEksPodIdentity()` keeps its behavior; it only gains the same
  `InvalidConfig` token-file guards.

- 73110de: Add public exports `PredicateArg` / `Predicate` / `Collection`; fix `Path<T>`
  for optional array fields

  **New public exports**

  - `PredicateArg`, `Predicate`, and `Collection` are now exported from
    `@gusto/baerly-storage`.
  - `PredicateArg` is now exported from `@gusto/baerly-storage/client` (which
    already exported `ClientCollection` and `Predicate`).

  These let you name the `.where(...)` argument and predicate types directly
  instead of hand-rolling a structural interface to accept a `Db` or a
  `BaerlyClient`. The client handle type stays `ClientCollection`; the in-process
  `Collection` type is root-only, because the client's HTTP handle is structurally
  distinct (read-only `.where(...)`, `TerminalOptions`).

  **Bug fix — optional array fields**

  `Path<T>` (the dotted-path key type behind `Predicate<T>` and `.where(...)`) now
  runs its leaf test on `NonNullable<T[K]>`, so `Path<{ tags?: string[] }>` is
  `"tags"` — an optional array ends path recursion exactly like a required one.
  Previously the `undefined` arm of `string[] | undefined` defeated the
  array-is-a-leaf check and synthesized bogus `Array.prototype` keys (`tags.map…`),
  which broke assignability of a bound `Db<Config>` / `BaerlyClient<Config>` to a
  hand-rolled structural `collection(name: string)` interface — even for
  collections that never used the array field.

  **Migration**

  No action required — both changes are additive. If you hand-rolled a structural
  `collection(name: string)` shim to read collections by a runtime-computed name,
  you can now import the real types or narrow at the boundary:

  ```ts
  (db as Db<UnboundConfig>).collection(name);
  ```

### Patch Changes

- 29bb00c: Refresh dependencies ahead of release. No public API changes.

  Runtime deps that ship to consumers:

  - `@logtape/logtape` 2.1.3 → 2.2.2
  - `hono` 4.12.25 → 4.12.27
  - `@hono/node-server` 2.0.4 → 2.0.6
  - `jose` caret floor `^6.2.0` → `^6.2.3`

  The `@gusto/create-baerly-storage` scaffolder picks up `@clack/prompts` 1.6.0.

  The `@logtape/logtape` growth was rebaselined with a dated note in the
  bundle-size budgets. (The XML parser was separately swapped from
  `fast-xml-parser` to `@rgrove/parse-xml` — see the parser-swap changeset — which
  removes `fast-xml-parser` and its transitive closure from the tree entirely.)

- 4813d9e: Swap `fast-xml-parser` for `@rgrove/parse-xml` in the S3 XML decode path
  (`@baerly/adapter-node`). No public API changes — all exported functions and
  types are unchanged.

  **Smaller bundle:** −87 KiB raw / −24 KiB gz / −14 KiB min-gz on the `s3.js`
  closure. `@rgrove/parse-xml` also has zero transitive dependencies, where
  `fast-xml-parser` pulled in `strnum` and `@nodable/entities` — so the
  supply-chain and audit surface both shrink.

  **CVE-class defense-in-depth (not an active-hole fix):** `fast-xml-parser`
  shipped ~6 CVEs across 5.x (CVE-2026-25896, CVE-2026-26278, CVE-2026-33036,
  and others), all in the DOCTYPE/entity surface. Our `<!DOCTYPE` regex guard
  already made those vectors unreachable — the pinned `fast-xml-parser@5.8.0`
  was never itself vulnerable — but each new CVE still forced a version-pin
  review. `@rgrove/parse-xml` parses and discards DTDs without resolving custom
  entities, so the entity-expansion CVE _class_ cannot recur even if that regex
  guard ever regressed. Removing the dependency also ends its dependabot cadence.

  **Intended entity-set difference (not a bug):** `@rgrove/parse-xml` decodes
  only the 5 predefined XML entities (`&amp; &lt; &gt; &quot; &apos;`) plus
  decimal and hex numeric character references. It does NOT decode HTML named
  entities (`&nbsp;`, `&mdash;`, etc.); the old code enabled `htmlEntities: true`
  solely to get numeric refs. S3/R2/MinIO wire data is XML, not HTML — no backend
  emits HTML-only named entities in `ListObjectsV2` or error responses — so the
  narrower set is more spec-correct.

  The swap was validated during development with a one-time differential-oracle
  test asserting field-for-field parity between the two parsers on generated
  S3-shaped XML (predefined entities, decimal/hex numeric refs, CDATA, singular
  and plural `<Contents>`). That check is not retained; going forward, parser
  behavior is pinned by the example-based contract tests in
  `packages/adapter-node/src/xml.test.ts`.

- e18e9c4: Reject `.` / `..` / empty object keys at the Storage boundary

  Every `Storage` adapter (`MemoryStorage`, `S3HttpStorage`, `r2BindingStorage`,
  `LocalFsStorage`) now validates the key on `get` / `put` / `delete` and throws
  `BaerlyError("InvalidConfig")` when the key is empty or has a `.` or `..`
  segment in its `/`-delimited path. Such keys can't be addressed over the S3/R2
  HTTP API: RFC 3986 dot-segment removal rewrites `<bucket>/.` to the bucket root
  before the request is signed, so a naive PUT fails as a confusing bucket-root
  `403` instead of a clear error. The check runs client-side, before any network
  call, so every backend rejects identically and the behavior ports cleanly to
  other languages.

  **What changed**

  - `get` / `put` / `delete` on all adapters reject `""`, `.`, `..`, and any key
    with a `.` or `..` path segment, with `InvalidConfig`. `list(prefix)` is
    unaffected — a prefix rides the `?prefix=` query component, where `.` / `..`
    are harmless.
  - The 1024-byte full-key ceiling is still enforced on the write path
    (`assertKeyWithinLimit`), where multi-segment keys are assembled.

  **Migration**

  - No action for normal use. The kernel never emits these keys, and
    caller-controlled segments (`_id`, `collection`, `app`, `tenant`) are already
    screened one layer up. If you call a `Storage` adapter directly with a bare
    `.` / `..` / empty key, catch `BaerlyError` and check `code === "InvalidConfig"`.
  - Shipped as a patch, not a minor: these keys were never addressable — a
    `.` / `..` / empty key already failed with an opaque bucket-root `403` — so no
    working call site changes behavior.

- b8b87e5: Write down the durable-contract promises: LogEntry is versionless, version axes
  are named and drift-gated, and backend capabilities are split into required vs.
  optional

  Documentation and internal tooling only. Nothing changes in the emitted bytes,
  the public API, or runtime behavior — this just records compatibility promises
  the project already relied on, so anyone building on the durable contract (the
  CDC-style `LogEntry` export, the bucket layout) can depend on them in writing.

  **LogEntry is versionless and additive-only (ADR-005, `docs/adr/005-logentry-versionless.md`)**

  - `LogEntry` carries no `schema_version`; the live wire contract is owned by
    `docs/spec/log-entry-shape.md`. Consumers **must ignore unknown keys** — a
    compatible release can add new optional fields at any time. Renaming a field,
    repurposing a value, removing a field, or widening `op` requires an explicit
    compatibility decision, a migration note, and a versioned release.

  **Version matrix + drift gate**

  - `docs/contributing/version-matrix.json` names every version axis in one place:
    package semver, `specVersion`, the per-artifact durable `schema_version`s, the
    `layout_version` cordon, and a reserved conformance `corpusVersion`.
  - `docs/contributing/conventions/versioning.md` states the pre-1.0 rules: no
    breaking wire/schema/layout change ships as a patch; while `0.x` it takes a
    minor plus a migration note.
  - `scripts/check-version-matrix.ts` fails `verify` on drift — it derives
    `specVersion` from the wire IR so the matrix can't diverge, and enforces
    package lockstep plus the LogEntry/layout/corpus sentinels. `gen:version-matrix`
    regenerates the artifact from the reference implementation.

  **Required vs. optional storage capabilities**

  - `docs/spec/capabilities.md` records what a backend MUST support to certify as
    a full `Storage` (CAS — exactly-one-winner conditional create — is required,
    not optional), what is optional, and a planned read-only `ReaderStorage` tier.

  **Migration**

  - No action required. Nothing in the emitted bytes, the public API, or runtime
    behavior changes. `SNAPSHOT_SCHEMA_VERSION` replaces a `1` literal with a named
    constant of the same value.

## 0.3.0

### Minor Changes

- 79cc324: First public release. `baerly-storage` is a vendorless document database that
  runs over any S3-compatible bucket — the data lives in your bucket and there is
  no runtime to operate. Commit is one conditional log append (`If-None-Match`)
  per collection, so each collection is linearizable; compaction and GC run
  in-band on writes (reads never tick); no operator cron or sidecar. First-class
  on Cloudflare Workers (R2) and self-hosted Node (S3), with day-one templates for
  both.

  Versions `0.1.x`–`0.2.0` were internal/experimental builds. They remain
  published, but this is the first release intended for outside use. **Still
  pre-1.0:** the on-disk format and public API may change between minor versions
  until 1.0 — pin your version.

  **New here? You're done — everything above is what you get.** The rest is for
  the few of you who ran an internal `0.1`–`0.2` build and need to know what
  changed since `0.2.0`. Reach out and I'll help you migrate.

  **Migrating from an internal build**

  - **Cheaper commits, and a breaking on-disk format (schema v3).** A write now
    costs 2 Class-A PUTs instead of 3 — appending the numbered `log/<seq>` entry
    _is_ the commit, so there is no separate `current.json` write. `current.json`
    becomes compactor-owned compaction state (`next_seq` → `tail_hint`,
    `+mean_entry_bytes`, `−tail_bytes`), and readers discover the true tail by
    forward-probe. **Buckets written under schema v2 are rejected with no
    migration path** — re-create the bucket (or `admin dump` on a v2 build →
    `admin restore` on this one). See ADR-004.
  - **`Db.transaction` removed — the document is the atomic unit.** Single-document
    writes are each atomic; there is no batch. Replace
    `db.transaction(name, tx => { tx.update(a); tx.update(b) })` with individual
    `db.collection(name).update(...)` calls. The both-or-neither guarantee is
    gone; model a single document as your consistency boundary. Re-adding
    transactions later is additive (under the API surface lock).
  - **Tighter key-segment validation.** One shared rule validates every
    caller-controlled segment (`_id`, `collection`, `app`, `tenant`), rejecting
    empty / `/` / `.` / `..` / control chars / reserved leading `_` / over-length
    as `InvalidConfig`. The per-segment byte cap drops 1024 → 256 (an existing
    `_id` of 257–1024 bytes can no longer be read-modified), and over-long
    assembled keys now fail early as `InvalidConfig` instead of an opaque provider
    `KeyTooLong`. HTTP (`/v1/since`) and the `baerly admin` CLI route through the
    same rule.

  **Fixed**

  - **The change feed no longer dies after 1024 writes to a collection.** The
    `/v1/since` cursor's sequence segment was 10-bit (`0..1023`); the 1025th write
    produced an invalid cursor the server then rejected with a `400`, permanently
    killing the feed. It is now 53-bit from a single source of truth.
  - **Concurrent create-if-absent has exactly one winner.** `LocalFsStorage` now
    uses an atomic `link(2)` exclusive create (was a TOCTOU read-then-write that
    could admit two winners and split-brain the commit path), and
    `baerly doctor --bucket` gains an `ifNoneMatch-concurrent` linearizability
    check. The property is asserted for every shipped adapter by the conformance
    suite.
  - **Adapter error contract + CVE floor.** Terminal socket failures from
    `S3HttpStorage` now surface as `BaerlyError{code:"NetworkError"}` instead of
    raw `fetch` throws; the `fast-xml-parser` floor is raised past the disclosed
    entity/numeric-reference advisories (bundle byte-neutral); and
    schema-mismatch errors now name the required version and prescribe recovery.
  - **GC stays bounded under backlog and concurrency.** The live-content-hash
    scan now walks the log in bounded chunks (was an unbounded `Promise.all` that
    could exceed Cloudflare's subrequest cap on a backlogged tail), and
    `gc/pending.json` is merged under CAS with bounded retry so a concurrent GC
    pass can no longer silently lose candidate marks.
  - **Scaffolded Node + Docker apps boot.** The `--with=docker --target=node`
    template now copies `baerly.config.ts` into the runtime image (the server
    entrypoint imports it), so the container no longer crashes on an
    unresolved-import error at startup.

## 0.2.0

### Minor Changes

- React hooks are now bound to your config via the `createBaerlyReact` factory.

  **Migration — agents: if you wrote the LEFT, use the RIGHT:**

  ```ts
  // before — loose hook exports (removed)
  import {
    BaerlyProvider,
    useQuery,
    useMutation,
    useBaerlyClient,
  } from "@gusto/baerly-storage/client/react";

  // after — factory bound to your defineConfig collections
  import { createBaerlyReact } from "@gusto/baerly-storage/client/react";
  const { Provider, useQuery, useMutation, useClient } =
    createBaerlyReact<typeof config>();
  ```

  The loose exports no longer exist; obtain the hooks from the factory so
  they are typed against your config (additive-only surface lock).

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

- Initial release of `@gusto/baerly-storage` — a vendorless document
  database over any S3-compatible bucket. Public surface: `Db.create()`,
  `db.collection(...)` with the eight-verb / three-modifier / six-operator
  query API, `defineConfig`, `createBaerlyClient`, the Cloudflare Workers and
  self-hosted Node adapters, and the `baerly` CLI. See `dist/API.md` for the
  full surface.

---

_Maintained by [Changesets](https://github.com/changesets/changesets); entries
at and below `0.2.0` were backfilled by hand from the git history. This file
ships in the published package at `dist/CHANGELOG.md` so an agent that expected
an older API can recover the current call. The `.d.ts` types are the canonical
authority — if this file and the types disagree, the types win. (The footer sits
below all versions because Changesets prepends new releases under the H1.)_
