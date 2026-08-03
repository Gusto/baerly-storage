# Pre-Stage-0 compatibility corpus

This directory freezes the literal artifact bytes captured from subject commit
`01bdd298ac19826e8141fe67cdfd3b62b4dcdd5e`. Every payload is bound to its raw
byte length and lowercase SHA-256 in `manifest.json`.

These bytes are never regenerated in place. A superseding capture gets a new
directory.

## Scope

The corpus freezes **protocol behavior** — snapshot bodies, log entries,
`current.json` heads, restore inputs, dump output, and SQL export bytes. Every
payload is produced by deterministic kernel and CLI code, so a re-capture at the
same subject commit reproduces the manifest hash exactly.

Packaging is deliberately **out of scope**. The published export map, the
declaration surface, and the `_internal` negative controls are owned and gated
by `scripts/check-exports.mjs`, which runs in CI via `pnpm run verify:package`.
An earlier revision of this corpus froze those artifacts too; it was dropped
because the packed manifest embeds `pnpm pack`'s workspace-dependency rewrite,
whose key order is a filesystem race — 11 distinct orders in 12 runs — so the
manifest hash was not reproducible and the payload duplicated a gate that
already exists.

## Regenerating

The capture tool refuses to overwrite a populated corpus, requires a clean
detached subject worktree physically distinct from the implementation checkout,
and writes its provenance exclusively. To produce a superseding capture:

```sh
# 1. Detached, clean subject worktree at the commit being frozen.
git worktree add --detach /tmp/baerly-subject <full-40-hex-commit>
cd /tmp/baerly-subject && pnpm install --frozen-lockfile && cd -

# 2. Capture into a NEW corpus directory and a NEW study directory.
pnpm run freeze:fold-stage0 \
  --subject-commit=<full-40-hex-commit> \
  --subject-worktree=/tmp/baerly-subject \
  --out=tests/fixtures/fold-stage0/<new-corpus-dir> \
  --provenance-out=docs/spec/attachments/fold-stage0/<new-study-dir>/capture-provenance.json

# 3. Clean up.
git worktree remove /tmp/baerly-subject
```

The tool prints one structured success record to stdout carrying
`corpus_manifest_sha256`, `corpus_file_count`, and
`capture_provenance_sha256`. Those values populate the study manifest under
`docs/spec/attachments/fold-stage0/<new-study-dir>/`, and `corpus_manifest_sha256`
is the value any later ratification cites to name the baseline it was judged
against.

## Findings

- `restore --force` lowers `log_seq_start`. This is deliberate. The
  `FLOOR EXEMPTION — deliberate` block in
  `packages/cli/src/admin/restore.ts:166` governs this behavior, and line 195
  says `` Do not "repair" this with `Math.max` ``. It is frozen as correct.
- Released `runDump` treats the legacy snapshot row key as authoritative when
  a row key and body `_id` diverge. The captured dump remaps `body-key` to
  `row-key`, and `runRestore` preserves that collapsed identity in the fresh
  target. `restore/identity-divergent.ndjson` is the real dump output from that
  flow.
- `readCurrentJson` accepts non-negative integers that are not safe integers.
  This open defect belongs to collation Task 2 Step 1 / PR B and is frozen
  as-is.
- `Writer` never re-reads `current.json` after the winning create, so a commit
  can land below a concurrently advanced floor and still be acknowledged. This
  open defect belongs to collation Task 2 Step 3a / PR B (Decision 4) and is
  frozen as-is.
