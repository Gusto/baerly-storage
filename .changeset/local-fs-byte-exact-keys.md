---
"@gusto/baerly-storage": patch
---

Fix `LocalFsStorage` (`localFsStorage` on the `/node` barrel, and the
`baerlyDev()` Vite plugin) merging keys that differ only by case or Unicode
normalization on a folding filesystem such as default macOS APFS.

Keys were written to the path made of their raw segments, so `A` / `a` and
NFC / NFD `é` landed on one file. Because index markers embed the raw `_id`
and collection names are interpolated raw into key prefixes, an indexed
`where` over such ids returned the wrong rows, a stale-marker delete for one
id de-indexed its twin, and `Users` / `users` shared one collection. S3,
Minio, R2, and `MemoryStorage` were never affected; Linux filesystems are
byte-exact, so this only diverged on macOS dev machines.

Keys are now byte-exact on every filesystem. Each key segment is escaped on
disk into a case- and normalization-invariant alphabet (`A` is stored as
`%41`, NFC `é` as `%c3%a9`). Lowercase ids, base-32 index values, and
`current.json` are stored verbatim. Segments too long for one filename are
split into `~`-suffixed directories. Keys containing lone surrogates are now
rejected with `InvalidConfig`, and dot-prefixed keys such as `.baerly-tmp-*`
are ordinary keys instead of reserved. A stray file that is not an encoded
key (a `README.md`, `Thumbs.db`, an editor backup) is skipped by `list`.

The data directory now carries a `.baerly-localfs.json` marker. An existing
directory is adopted as-is only when every name in it, dot-prefixed names
included, already reads the same under the new encoding: true of trees whose
ids, collection, app, and tenant names are lowercase ASCII and do not start
with `.`. Leftover `.baerly-tmp-*` staging files and `.DS_Store` are
ignored. Otherwise every operation refuses with `InvalidConfig`, listing the
affected paths. To recover, dump the directory with the previous release
(`baerly admin dump`) and restore into a fresh directory (`baerly admin
restore`). There is no in-place migration: keys a folding filesystem has
already merged cannot be recovered.
