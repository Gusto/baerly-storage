---
"@gusto/baerly-storage": minor
---

Harden key-segment validation: tighter, uniform limits on every caller-controlled
key segment (`_id`, `collection`, `app`, `tenant`).

One shared rule now validates all of them — rejecting empty / `/` / `.` / `..` /
control characters / the reserved leading `_` / over-length segments as
`BaerlyError{code:"InvalidConfig"}`. Two behavior changes worth calling out:

- **Per-segment byte cap drops 1024 → 256.** Any segment between 257 and 1024
  bytes that the old `_id`-only check accepted is now rejected. Because the `_id`
  guard also runs in the commit path, **an existing document whose `_id` is
  257–1024 bytes can no longer be updated, replaced, or deleted** — the check
  fires on the read-modify path, not just on insert. Acceptable pre-launch (no
  such data exists); flagged so it is not a surprise later.
- **Over-long _assembled_ keys now fail early.** A key whose full length exceeds
  1024 UTF-8 bytes (e.g. a long collection + long index value + long `_id`, or a
  base-32-inflated index value) previously failed late as an opaque provider
  `KeyTooLong`; it now surfaces at commit time as `InvalidConfig`.

Also closes traversal bypasses defensively at the boundary: `GET /v1/since`
(and the underlying `Db.getCurrentJson` / `getLogEntry`) now validate the
`collection` segment, and `baerly admin restore` can no longer write a
traversal-shaped `_id` because `Writer.commit` validates it. The `baerly` CLI
admin commands (`admin restore`, `admin dump`, `admin fsck`,
`admin rebuild-index`, `inspect`, `export`, `cost`) now route their `app` /
`tenant` / `collection` arguments through the same shared rule — `app` / `tenant` at the
`resolveAppTenant` chokepoint and `collection` per command — so a traversal /
empty / control-char value fails fast as `InvalidConfig` instead of building a
garbage or wrong-namespace key. The operator surface is covered, not just HTTP.

This is input-tightening — semantically a breaking change, released as `minor`
only because we are pre-1.0 / pre-launch with no consumers relying on the old
limits.
