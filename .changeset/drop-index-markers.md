---
"@gusto/baerly-storage": minor
---

**Breaking:** writes no longer create or delete index markers. A declared index changes no storage call: an insert, update, or delete on a collection that declares indexes costs exactly what it costs on one that does not, and the committing `log/<seq>` create is the write's only storage write. Every read already took its rows from the snapshot and log, so no read result changes.

- Nothing is written under `<collection>/index/` any more, and an update or delete no longer reads back the row's previous log entries to find stale markers.
- A row may now hold an array in a declared index field (that write used to throw `SchemaError`), or a value long enough that its marker key passed the 1024-byte key limit (that write used to throw `InvalidConfig`).
- On Workers Free with storage over `fetch` (S3 over HTTP), the most expensive write request, maintenance included, drops from 45 to 31 calls (44 to 30 storage calls, plus one Cache API call). The "3 indexes per write" bound and the refusal of an update that changes 9 or more indexed fields are gone; a write is refused only once 32 or more writes are pending, whatever indexes are declared.
- The `db.write.index_ops_per_logical_write` histogram and the `db.write.index_cleanup_errors_total` counter are no longer emitted. `db.write.post_commit_refused_total` keeps only `phase: "delete-floor-check"`.

**Legacy markers.** Objects that earlier releases wrote under `<collection>/index/` are inert: nothing reads, writes, or reclaims them, and keeping them is harmless. To reclaim the bytes once a rollback is no longer possible, delete the prefix (see "Legacy index markers" in `docs/guide/backups.md`):

```sh
aws s3 rm --recursive --dryrun "s3://bucket/app/acme/tenant/t1/manifests/tickets/index/"
```

**Rollback and mixed fleets.** A 0.6 instance takes an indexed query's rows from the markers, so while it reads a collection that 0.7 has written to (a rolling deploy, or after rolling back), its indexed queries miss every row 0.7 inserted or changed. After rolling back to 0.6, run 0.6's `baerly admin rebuild-index` once per declared index to repair them. 0.7 ignores markers a 0.6 writer keeps creating.

**Migration — agents: if you wrote the LEFT, use the RIGHT:**

```ts
// before
collections: { tickets: { indexes: [{ name: "by_status", on: "status" }] } }
// after: omit `indexes`; it changes no read, no write, and no cost
collections: { tickets: {} }
```

Dashboards on `db.write.index_ops_per_logical_write` or `db.write.index_cleanup_errors_total` read empty from now on; remove them.
