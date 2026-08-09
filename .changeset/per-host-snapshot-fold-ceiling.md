---
"@gusto/baerly-storage": minor
---

Give each host profile its own snapshot fold ceiling.

All three maintenance profiles shared `C = 512 KiB` (`maxFoldBytes`) and
`E = 2048` (`maxFoldRows`), both calibrated for a Cloudflare free isolate's
~10 ms CPU budget. Serverful Node and Cloudflare paid inherited them. Because
the fold gate is `snapshot_rows + maxFoldEntriesPerPass <= E`, and those two
profiles fold a 200-entry slice against free's 20, the bigger host capped
*lower*: ~1,848 live documents against free's ~2,028.

Each profile now carries a ceiling measured against its own wall:

| Profile | `C` | `E` | Documents at 1-5 KB/doc |
| --- | --- | --- | --- |
| cf-free | 512 KiB | 2,048 | ~100-500 (unchanged) |
| cf-paid | 8 MiB | 32,768 | ~1,600-8,200 |
| node | 32 MiB | 65,536 | ~6,500-32,800 |

**Behaviour change.** A collection on serverful Node or Cloudflare paid that
was deferring its fold against the old shared ceiling starts folding again on
the next write tick, and its log tail begins collapsing into the snapshot
again. Nothing else moves: a read already folded snapshot plus live tail, so
the materialized view is unchanged either way, and the per-pass rate caps are
untouched.

Cloudflare paid takes its ceiling only when `BAERLY_MAINTENANCE_PROFILE=cf-paid`
is set — a paid Worker runs the free-tier profile by default. The Node adapter
selects its profile automatically. `BAERLY_MAINTENANCE_MAX_FOLD_BYTES` still
overrides `C` on any host; there is still no override for `E`, so a row-arm
defer is cleared by moving to a larger host profile rather than by
configuration.

Bytes now bind before rows on every host for documents of ~512 B and up, so
`E` acts as the tiny-document backstop it was designed to be rather than as
the effective ceiling.
