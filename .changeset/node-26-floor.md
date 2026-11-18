---
"@gusto/baerly-storage": minor
---

**Breaking:** `engines.node` is now `>=26` (was `>=24`). Node 26 is the current LTS and ships `Uint8Array.{toBase64,fromBase64}` unflagged, so no runtime flag is needed. Scaffolded apps declare `packageManager: pnpm@12.21.0` and enable pnpm's supply-chain guardrails (`minimumReleaseAge`, `trustPolicy: no-downgrade`, `blockExoticSubdeps`) in `pnpm-workspace.yaml`. The Docker add-on builds on `node:26-trixie-slim` and runs on `gcr.io/distroless/nodejs26-debian13`.
