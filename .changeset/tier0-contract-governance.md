---
"@gusto/baerly-storage": patch
---

Write down the durable-contract promises: LogEntry is versionless, version axes
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
