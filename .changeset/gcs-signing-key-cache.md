---
"@gusto/baerly-storage": patch
---

`goog4Signer` and `gcsStorage` reuse the derived GOOG4 signing key for the same secret and UTC day, and no longer read a bodyless request's body to hash it.
