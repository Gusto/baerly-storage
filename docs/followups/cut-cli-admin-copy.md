# Cut `baerly admin copy`

**Severity: MEDIUM. Pre-launch cut. Explicit borrowed maturity
from a production vector DB; `dump | restore` already covers the
audience's "copy" need with ~10× fewer LoC.**

`baerly admin copy` does a cross-bucket point-in-time snapshot
copy via a `<currentJsonKey>@<etag>` cursor; bypasses write-path
compaction.

- `/Users/eric.baer/workspace/baerly-storage/packages/cli/src/admin/copy.ts`
  (~336 LoC)
- `/Users/eric.baer/workspace/baerly-storage/packages/cli/src/bucket-uri.ts` —
  `parseCursor` exists only for this verb's ETag-cursor grammar.

## The case for cutting

The verb's own prior-art citation is **Turbopuffer's
`copy_from_namespace` 75% write discount**. That's a production
vector DB explicitly building for managed-CDC-pipeline workloads.
The audience for baerly is not that audience.

Two reference-class signals from the deferred changes-iterator
memo apply directly:

1. **§2 "The graduation story already covers the legitimate CDC
   workloads"** — the workload that needs cross-bucket
   point-in-time copy at scale is on D1/Postgres, where real CDC
   pipelines exist.
2. **§5 "Borrowed maturity is the wrong signal pre-launch"** —
   modeling on Turbopuffer borrows maturity baerly doesn't claim.

The audience's "copy" use case is already covered by
`baerly admin dump | baerly admin restore` (NDJSON round-trip).
The ETag-cursor grammar (`<key>@<etag>`) is a separate parsing
surface that exists only for this verb.

## What to do

1. Delete `packages/cli/src/admin/copy.ts` and its citty
   subcommand wiring.
2. Delete the `parseCursor` machinery in
   `packages/cli/src/bucket-uri.ts` if no other verb consumes it
   (verify; the `<key>@<etag>` grammar is copy-specific).
3. Drop the `admin copy` row from `CLAUDE.md`'s verification
   table.
4. Audit docs / examples for any reference to the verb.

## What gets harder after

- A user who wants a cross-bucket copy without dump/restore
  overhead has no purpose-built verb. **Acceptable** — dump/restore
  works at the workload sizes the ceiling commits to (~10 GB/tenant).
- The point-in-time ETag cursor surface goes away. **Acceptable** —
  no audience consumer uses it.

## Related cuts

- Part of the **admin verb bloat** theme.
