---
"@gusto/baerly-storage": patch
---

Fix `LocalFsStorage.put` failing with `EXDEV` whenever the bucket root and
`os.tmpdir()` are on different filesystems.

The write path that serves unconditional and `ifMatch` puts staged its temp
file in `os.tmpdir()` and then `rename`d it onto the destination under the
bucket root. `rename(2)` refuses to cross filesystems, so on any host where
those are separate volumes *every* such put failed with
`BaerlyError{code:"InvalidResponse"}` wrapping `EXDEV`, with no fallback.

That is the ordinary self-hosted shape, not an exotic one. The default root
is `<cwd>/.baerly-data`, which in a container is a mounted data volume while
`/tmp` is a tmpfs or the image layer, and the same split is routine on
systemd hosts (`/tmp` on tmpfs), for `$BAERLY_DATA_DIR` pointed at a network
mount, and for `baerly export` / `admin restore` against a `file:///…` URI on
another disk. It made the documented zero-credential path —
`baerlyNode({ config, storage: localFsStorage() })`, from that factory's own
`@example` — dead on arrival there.

Both write paths now stage their temp as a sibling of the destination, which
is what the `ifNoneMatch:"*"` branch already did (its `link(2)` create has
the same cross-device constraint). The temp is named with the reserved
`TEMP_PREFIX` that `walk` filters at every depth, so a crash between staging
and publishing leaves a file invisible to `list` rather than a bogus key —
that filter is what makes staging inside the bucket safe. Cleanup moved to a
`try/finally`, so a failed write no longer strands the partial body.

A temp-write failure also now surfaces as `BaerlyError{code:"InvalidResponse"}`
like every other error from this adapter; previously the `writeFile` sat
outside the `try` and escaped as a raw Node `ErrnoException`.
