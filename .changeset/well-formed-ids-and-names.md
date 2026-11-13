---
"@gusto/baerly-storage": minor
---

**Breaking:** a document `_id` and an app, tenant, or collection name may no longer contain an unpaired UTF-16 surrogate (`value.isWellFormed()` must be `true`). `insert` with a caller-supplied `_id`, `replace`, `POST /v1/c/:collection`, and `baerly admin restore` refuse such an `_id` with `InvalidConfig` (HTTP 400, message included) before writing. Every surface that refuses a non-NFC name (`Db.create`, `db.collection`, every HTTP route, `ensureTable`, and the writing CLI verbs) refuses such a name with `InvalidConfig`. The HTTP client refuses either one with `InvalidConfig` before sending a request, where it used to throw a `URIError`. Surrogate pairs (emoji and other astral characters) are well-formed and still accepted.

Such a row was unaddressable over HTTP: the client's `encodeURIComponent` threw, and no percent-encoding reaches the route as the same id. The S3 and GCS adapters threw a raw `URIError` on any key holding one, and local-fs refused the key.

**Migration — agents: if you wrote the LEFT, use the RIGHT:**

```ts
// before: slicing can split a surrogate pair
await notes.insert({ _id: title.slice(0, 40), title });
// after: slice by code point, or let the SDK mint a UUID
await notes.insert({ _id: Array.from(title).slice(0, 40).join(""), title });
await notes.insert({ title });
```

Rows already stored under such an `_id` stay readable and deletable in-process: `get`, `where`, and `delete` accept them, while `update` and `replace` refuse them. To find them, run `baerly admin dump --json --bucket=<uri> --app=<app> --tenant=<tenant> --collection=<name>`; its `legacy.ill_formed_ids` field lists them (text mode prints a stderr warning), including under `--recover-legacy-names`. To keep one writable, read it by `_id`, insert a copy under a well-formed `_id` (for example, omit `_id` for a UUID), then delete the original with the SDK. To migrate a whole collection, give each listed row a well-formed `_id` in the dump and `baerly admin restore` it into a new collection.

A name with an unpaired surrogate never reached S3, GCS, or local-fs storage, and the CLI cannot pass one (Node decodes such argv bytes to U+FFFD); a programmatic `runDump` that does reports it in `legacy.ill_formed_names`. If a Worker on the R2 binding stored data under such a name, copy it to a well-formed name with that Worker on your current release before upgrading.
