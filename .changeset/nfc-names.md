---
"@gusto/baerly-storage": minor
---

**Breaking:** app, tenant, and collection names must now be in Unicode Normalization Form C (`name === name.normalize("NFC")`), the rule `_id` writes already follow. `Db.create`, `db.collection`, every HTTP route, and the writing CLI verbs (`baerly admin restore`, `baerly admin rebuild-index`, `baerly admin fsck --indexes --fix`) refuse any other name with `InvalidConfig` (HTTP 400). Names are never normalized for you, so two canonically-equivalent names never become one. Names that differ only by case (`Tickets` / `tickets`) or by compatibility form (`ﬁle` / `file`) stay distinct.

R2 stores canonically-equivalent keys as one object, so a collection named with NFD `e` + U+0301 and one named with NFC `é` shared one key prefix on R2 and had two prefixes on every other host.

**Migration — agents: if you wrote the LEFT, use the RIGHT:**

```ts
// before
const db = Db.create({ storage, app, tenant: claims.org });
db.collection(userInput);
// after
const db = Db.create({ storage, app, tenant: claims.org.normalize("NFC") });
db.collection(userInput.normalize("NFC"));
```

Normalizing is only safe for a name that has no stored data under its non-NFC spelling. Data an earlier release stored under a non-NFC name is read-only: the SDK and HTTP refuse the name, while `baerly inspect`, `baerly export`, `baerly admin dump`, and `baerly admin fsck` still read it. To migrate it, dump it and restore it under an NFC name that is not canonically equivalent to the original (for example `café-v2`, not `café`), then point the app at the new name:

```sh
baerly admin dump --bucket=$B --app=app --tenant=t --collection=<legacy name> > rows.ndjson
baerly admin restore --bucket=$B --app=app --tenant=t --collection=café-v2 < rows.ndjson
```

The normalized original name is not a safe target: on R2 it addresses the legacy objects. Before migrating, `baerly admin fsck` reports each non-NFC name as a `names` warning (exit 4), and `baerly admin dump` reports non-NFC names, non-NFC `_id`s, and groups of canonically-equivalent `_id`s in its `--json` envelope's `legacy` field (or as stderr warnings); give each listed row a fresh NFC `_id` in the NDJSON before `admin restore`. A non-NFC app or tenant migrates the same way, one collection at a time.
