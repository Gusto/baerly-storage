---
"@gusto/baerly-storage": patch
---

`baerly admin restore --force` no longer takes the old log tail from a LIST alone. On stores whose LIST lags (R2), a recently created `log/<seq>` could be missing from the listing, so the new generation started below it and the old row was replayed into the restored collection. The reseed now also walks forward with point GETs from the listed tail, and from the old `tail_hint`, to the first missing slot and uses the highest result.
