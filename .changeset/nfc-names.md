---
"@gusto/baerly-storage": minor
---

**Breaking:** app, tenant, and collection names must now be in Unicode Normalization Form C (`name === name.normalize("NFC")`), the rule `_id` writes already follow. `Db.create` (including `config.collections` keys), `db.collection`, every HTTP route, `ensureTable`, and the writing CLI verbs (`baerly admin restore`, `baerly admin rebuild-index`, `baerly admin fsck --indexes --fix`) refuse any other name with `InvalidConfig` (HTTP 400). Names are never normalized for you, so two canonically-equivalent names never become one. Names that differ only by case (`Tickets` / `tickets`) or by compatibility form (`ﬁle` / `file`) stay distinct.

R2 stores canonically-equivalent keys as one object, so a collection named with NFD `e` + U+0301 and one named with NFC `é` shared one key prefix on R2 and had two prefixes on every other host.

**Migration — agents: if you wrote the LEFT, use the RIGHT:**

First find stored non-NFC names: `baerly admin usage --target=node --bucket=<uri> --app=<app> --tenant=<tenant>` reports each non-NFC app, tenant, or listed collection name, and each pair of canonically-equivalent collection names, as a `names` warning. It scans only the `--tenant` you pass, so list every tenant your verifier can mint and scan each. Listed key spellings are not a complete inventory of the names stored in log and snapshot bodies. Normalizing is only safe for a name that has no stored data under its non-NFC spelling. The SDK and HTTP refuse non-NFC names, while the read-only CLI still accepts them. On R2 a normalized collection name can address legacy objects: reads and folds that encounter the other collection spelling refuse with `InvalidConfig` rather than skip those rows. Stored records do not identify the app or tenant, so this alias guard cannot detect a normalized legacy app or tenant; those aliases can still read and modify the same data. Migrate them to fresh namespaces instead of relying on rejection.

For a name with no stored non-NFC data:

```ts
// before
const db = Db.create({ storage, app, tenant: claims.org });
db.collection(userInput);
// after
const db = Db.create({ storage, app, tenant: claims.org.normalize("NFC") });
db.collection(userInput.normalize("NFC"));
```

To migrate stored data, dump it and restore it under an NFC name that is not canonically equivalent to the original (for example `café-v2`, not `café`), then point the app at the new name:

```sh
baerly admin dump --bucket=$B --app=app --tenant=t --collection=<legacy name> > rows.ndjson
baerly admin restore --bucket=$B --app=app --tenant=t --collection=café-v2 < rows.ndjson
```

The normalized original name is not a safe target: on R2 it addresses the legacy objects. Before migrating, `baerly admin fsck` reports each non-NFC name as a `names` warning (exit 4), and `baerly admin dump` reports non-NFC names, non-NFC `_id`s, and groups of canonically-equivalent `_id`s in its `--json` envelope's `legacy` field (or as stderr warnings); give each listed row a fresh NFC `_id` in the NDJSON before `admin restore`. A non-NFC app or tenant migrates the same way, one collection at a time.

If a legacy R2 log contains both collection spellings, ordinary dump and export refuse it. Stop writes and maintenance and preserve a copy of the source bucket. Recover each original spelling separately with `baerly admin dump --recover-legacy-names --bucket=$B --app=app --tenant=t --collection=<exact stored name> > rows.ndjson`, then restore each dump into a different fresh NFC collection. Recovery matches collection names byte-for-byte, so overlapping `_id`s, updates, and deletes from the other spelling never merge into the selected collection. Text mode warns on stderr; `--json` reports `recovery: { collection_match: "exact", historical_completeness: "not_guaranteed" }` in the result envelope.

Recovery requires either no snapshot or a snapshot naming the selected spelling, and retains the normal snapshot hash and dense-log checks. A snapshot naming the other spelling is refused rather than treated as an empty base. Earlier compaction may already have discarded rows belonging to the other spelling; this command cannot reconstruct them or certify historical completeness. Keep the source copy for separate recovery if the snapshot does not match.
