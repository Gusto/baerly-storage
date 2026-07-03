---
"@gusto/baerly-storage": patch
---

Ratify the contract-governance foundation: LogEntry is versionless, version
axes are named and drift-gated, and backend capabilities are split into
required vs. optional

This is documentation and internal-tooling only — no public API, wire, or
runtime behavior changes. It writes down compatibility promises the project
was already relying on implicitly, so external consumers of the durable
contract (the CDC-style `LogEntry` export, the bucket layout) can depend on
them.

**LogEntry is versionless and additive-only (ADR-005, `docs/adr/005-logentry-versionless.md`)**

- `LogEntry` carries no `schema_version`; the live wire contract is owned by
  `docs/spec/log-entry-shape.md`. Consumers **must ignore unknown keys** — new
  optional fields can be added in a compatible release. Renaming a field,
  repurposing a value, removing a field, or widening `op` requires an explicit
  compatibility decision, a migration note, and a versioned release.

**Version matrix + drift gate**

- `docs/contributing/version-matrix.json` names every version axis in one place
  (package semver, `specVersion`, the per-artifact durable `schema_version`s,
  the `layout_version` cordon, and a reserved conformance `corpusVersion`).
- `docs/contributing/conventions/versioning.md` states the pre-1.0
  compatibility rules: no breaking wire/schema/layout change ships as a patch;
  while `0.x` it takes a minor plus a migration note.
- `scripts/check-version-matrix.ts` gates drift in `verify` (derives
  `specVersion` from the wire IR so the matrix can't diverge, and enforces
  package lockstep plus LogEntry/layout/corpus sentinels). `gen:version-matrix`
  regenerates the artifact from the reference implementation.

**Required vs. optional storage capabilities**

- `docs/spec/capabilities.md` records what a backend MUST support to certify as
  full `Storage` (CAS / exactly-one-winner conditional create is not optional),
  what is optional, and a planned read-only `ReaderStorage` tier.

**Migration**

- No action required. Nothing in the emitted bytes, the public API, or runtime
  behavior changes; `SNAPSHOT_SCHEMA_VERSION` replaces a `1` literal with a
  named constant of the same value.
