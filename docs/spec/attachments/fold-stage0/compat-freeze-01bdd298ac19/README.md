---
title: Stage 0 compatibility freeze — compat-freeze-01bdd298ac19
audience: maintainer
doc_type: verification
summary: Immutable evidence record binding the pre-Stage-0 compatibility corpus to source commit 01bdd298ac19826e8141fe67cdfd3b62b4dcdd5e and its per-file SHA-256 hashes.
last-reviewed: 2026-08-03
tags: [evidence, fold-stage0, compatibility, immutable]
related: ["../../../sync-protocol.md"]
---

# Stage 0 compatibility freeze — `compat-freeze-01bdd298ac19`

This immutable study record binds the literal pre-Stage-0 compatibility corpus
captured from commit `01bdd298ac19826e8141fe67cdfd3b62b4dcdd5e` at
`2026-08-03T18:16:53.976Z` to its capture provenance and raw-byte hashes.

It is evidence only. Capturing a baseline neither ratifies a Stage 0 design nor
changes production behavior; `corpus_manifest_sha256` below is the value a
ratification cites, and the ratification itself is recorded outside this
directory so that signing it never rewrites immutable evidence.

## Identity

- `study_id`: `compat-freeze-01bdd298ac19`
- Derivation: `"compat-freeze-" + frozen_subject_commit.slice(0, 12)`
- `supersedes: null` — this is the first Stage 0 study.
- Frozen subject commit: `01bdd298ac19826e8141fe67cdfd3b62b4dcdd5e`
- Corpus manifest SHA-256:
  `2fe321e8e817f983fd6a144125a7c5bec11a5e7a80c80649fa072757dbcda230`
- Corpus file count: 31

## Reproducibility

The corpus hash is **independently re-derivable**. Every payload is produced by
deterministic kernel and CLI code, so re-running the capture tool against a
clean detached worktree at the frozen subject commit reproduces
`corpus_manifest_sha256` exactly. That property was verified across two captures
on different Node majors (`v26.5.0` and `v24.16.0`): all 31 protocol payloads
came back byte-identical.

That is what makes citing this hash a verification rather than an act of trust:
a reviewer re-derives it instead of believing it. An earlier revision of this
corpus also froze packaging artifacts —
the packed manifest, resolved export map, declaration inventory, and
`_internal` negative controls. Those were dropped: the packed manifest embeds
`pnpm pack`'s `workspace:*` dependency rewrite, whose key order is decided by a
filesystem race inside `Promise.all` (measured: 11 distinct orders in 12 runs),
so the manifest hash could not be reproduced. Packaging is owned and gated by
`scripts/check-exports.mjs` under `pnpm run verify:package` in CI, which already
rejects `_internal` subpaths and carries TypeScript negative controls.

## Evidence locations

The test-consumed literal corpus lives at
`tests/fixtures/fold-stage0/pre-change/`. This directory is the promoted,
reviewed evidence record of that freeze. Regeneration instructions live with the
corpus.

**Coordinator flag:** This two-location split is this plan's reading of
coordination §3 against the collation plan's Task 0 file list, which places the
corpus under `tests/fixtures/`. It is not an authority statement.

## Immutability

This directory is append-only historical evidence **from the commit that merges
it forward**. Its contents are never regenerated or overwritten in place.

> A superseding study gets a new directory and links to the prior study; it
> never overwrites the earlier directory.

This record does not touch
`docs/spec/attachments/fold-cost-baseline.json`, which remains byte-for-byte
historical and is never migrated in place.

`manifest.json` binds every retained artifact other than itself. The sibling
`files.sha256` ledger binds `capture-provenance.json`, `manifest.json`, and this
README using their final raw bytes; it does not contain an unsatisfiable
self-hash entry.
