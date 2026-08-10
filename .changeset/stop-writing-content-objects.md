---
"@gusto/baerly-storage": minor
---

New insert and update commits no longer create `content/<sha>.json` side objects. The committing `log/<seq>.json` create remains the commit point, and existing content objects are left in place and are inert.

**Migration — direct-bucket consumers: if you did the LEFT, use the RIGHT:**

```ts
{
  // before: derive, fetch, and decode the post-image side object
  if (entry.after === undefined) throw new Error("entry has no post-image");
  const bytes = encodeJsonBytes(entry.after);
  const version = await versionFromContent(bytes);
  const got = await storage.get(`${collectionPrefix}/content/${version}.json`);
  if (got === null) throw new Error("legacy content object is missing");
  const body = decodeJsonBytes<DocumentData>(got.body);
}

{
  // after: the committed post-image is inline
  if (entry.after === undefined) throw new Error("entry has no post-image");
  const body: DocumentData = entry.after;
}
```

Normal `@gusto/baerly-storage` API consumers and existing v0.6.0 buckets require no migration. Legacy content objects are inert: no reader opens one and GC does not touch the prefix. Delete them yourself when you want the bytes back.

A content-free GC tick also refreshes a stale `tail_hint` afterwards, so a collection that GCs without ever folding keeps its read and write forward-probes bounded instead of re-walking a growing live tail. Any one maintenance tick now publishes `tail_hint` at most once, so a fold or a deferral that already stamped it never costs a second, byte-identical `current.json` write.

baerly cost now keeps the exact 1M-Class-A/month R2 boundary inside the inclusive free tier instead of reporting a zero-dollar overage.
