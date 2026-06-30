---
"@gusto/baerly-storage": minor
---

Fail closed on ephemeral storage in production

`MemoryStorage` now refuses to construct in a detected deployment
(`NODE_ENV=production` or a known PaaS marker) unless ephemerality is
explicitly acknowledged. This prevents the silent-data-loss failure mode where
an app falls back to in-memory storage in production — writes "succeed" into
process RAM and vanish on every restart, with no loud signal.

**What changed**

- `new MemoryStorage()` throws `BaerlyError("InvalidConfig")` in a detected
  deployment. Tests and local dev are unaffected (neither sets those signals).
- New `resolveStorageFromEnv(env?)` export on `@gusto/baerly-storage/node`: the
  safe, tested storage selector the Node example scaffolds now use, so apps
  don't hand-roll one with a silent fallback.
- New `assertStorageReachable(storage)` export on `@gusto/baerly-storage/node`:
  an opt-in boot/readiness check that fails closed on an unreachable or
  CAS-broken bucket (the wrong-bucket-name gap a missing-bucket guard can't
  catch).
- New pure `isDeployedEnv(env)` predicate on `@gusto/baerly-storage`.

**Migration**

- If you intentionally run in-memory storage in a deployed environment (e.g. a
  throwaway demo), opt in explicitly — either in code:

  ```ts
  new MemoryStorage({ ephemeral: true })
  ```

  or via the environment:

  ```sh
  BAERLY_ALLOW_EPHEMERAL_STORAGE=true
  ```

- No action needed for tests, local dev, or apps already using a real S3/R2
  bucket.

**Platform note**

- The guard is effectively Node-only. A Cloudflare Worker requires an R2
  binding and has no silent in-memory fallback path, and the deploy-detection
  predicate reads `process.env`, which is empty on Workerd — so the guard never
  fires (and never needs to) on Cloudflare.
- CI environments are never treated as deployed. When `CI` is set (to a
  non-empty, non-`false` value) the PaaS-marker detection is suppressed, so
  `MemoryStorage` still constructs in CI — including Kubernetes-hosted CI agents
  that set `KUBERNETES_SERVICE_HOST`. An explicit `NODE_ENV=production` still
  trips the guard.
