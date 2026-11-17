---
"@gusto/baerly-storage": minor
---

Fix `LocalFsStorage` (`localFsStorage` on the `/node` barrel, and the `baerlyDev()` Vite plugin) merging keys that differ only by case or Unicode normalization on a folding filesystem such as default macOS APFS.

Keys were written to the path made of their raw segments, so `A` / `a` and NFC / NFD `é` landed on one file. Because collection names are interpolated raw into key prefixes, `Users` / `users` shared one collection. S3, Minio, and `MemoryStorage` were never affected; Linux filesystems are byte-exact, so this only diverged on macOS dev machines. R2 folds Unicode normalization (not case) the same way; that is addressed by requiring NFC `_id`s.

Keys are now byte-exact on every filesystem. Each key segment is escaped on disk into a case- and normalization-invariant alphabet (`A` is stored as `%41`, NFC `é` as `%c3%a9`). Lowercase ids, base-32 index values, and `current.json` are stored verbatim. Segments too long for one filename are split into `~`-suffixed directories. Keys containing lone surrogates are now rejected with `InvalidConfig`, and dot-prefixed keys such as `.baerly-tmp-*` are ordinary keys instead of reserved. A stray file that no key can name (an editor backup such as `current.json~`) is skipped by `list`; on a case-folding filesystem, a stray that the filesystem resolves a key to (`README.md` is what `get("readme.md")` reads, and under APFS's full case folding `Straße` is what `get("strasse")` reads) makes `list` fail with `InvalidConfig` naming the file, rather than hide a key the other operations see.

The data directory now carries a `.baerly-localfs.json` marker. A directory from an older release is adopted as-is only when every name in it, dot-prefixed names included, already reads the same under the new encoding: lowercase ASCII ids and collection, app and tenant names, nothing starting with `.`, and no snapshot. Leftover `.baerly-tmp-*` staging files and `.DS_Store` / `.gitkeep` files are ignored. Otherwise every operation refuses with `InvalidConfig`, listing the affected paths. The two common causes are a folded collection (snapshot files live under `snapshot/L9/`, now stored as `snapshot/%4c9/`) and an uppercase letter in a collection name or id, such as a camelCase name like `boardInvitees`. There is no in-place migration: keys a folding filesystem has already merged cannot be recovered.

A refused directory is dev data from an older release: move it aside or delete it, and the next write starts a fresh one. For a collection worth keeping, dump it with the older release (`baerly admin dump`) and restore it into the fresh directory (`baerly admin restore`). A dump holds collection rows only; for blobs or other files the app stored through the same `Storage`, re-put them through `Storage` instead: read each with the older release and write it with this release. A raw file copy does not work, because a file whose name holds an uppercase letter or other escaped byte does not read back as the same key under the new encoding, and `list` refuses it. A listed path that is a stray file rather than data can simply be moved out.

**Migration — agents: if you wrote the LEFT, use the RIGHT:**

```sh
# before: 0.6.0 reused the data directory in place
# after: when the directory is refused with InvalidConfig, move it aside
mv ./data ./data-0.6
# only for a collection worth keeping: dump with the older release, restore with this one
baerly admin dump    --bucket=file://$PWD/data-0.6 --app=app --tenant=t --collection=tickets > tickets.ndjson   # 0.6.0 binary
baerly admin restore --bucket=file://$PWD/data     --app=app --tenant=t --collection=tickets < tickets.ndjson   # this release
```
