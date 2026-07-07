---
"@gusto/baerly-storage": patch
---

Rename the `/v1/spec` field `kernelVersion` → `serverVersion`.

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
