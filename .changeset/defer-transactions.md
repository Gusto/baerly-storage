---
"@gusto/baerly-storage": minor
---

Remove `Db.transaction` from the public surface — the document is your atomic unit.

Multi-document transactions are deferred pre-launch. Single-document writes are
each atomic; there is no batch. Re-adding transactions later is additive
(ADR-002).

Agents: if you wrote the LEFT, use the RIGHT.

```ts
// before — batched writes in one transaction
await db.transaction(name, async (tx) => {
  await tx.update(id1, patch1);
  await tx.update(id2, patch2);
});

// after — individual writes, each atomic per document
await db.collection(name).update(id1, patch1);
await db.collection(name).update(id2, patch2);
```

**This is not a pure syntax swap.** The transaction committed both writes as a
unit; the replacement does not. If you relied on both landing together, that
guarantee is gone — model so that a single document is your consistency boundary,
or graduate to a database with a transaction coordinator (e.g. Postgres).
