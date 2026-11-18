---
"@gusto/baerly-storage": patch
---

Both packages now publish from GitHub Actions with npm trusted publishing, so every release carries a provenance attestation (`npm audit signatures` verifies it). Scaffolded apps set pnpm's `trustPolicy: no-downgrade`, which refuses a later version that lacks provenance, so a release published outside this workflow can't reach them.
