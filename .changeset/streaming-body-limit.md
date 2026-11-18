---
"@gusto/baerly-storage": patch
---

The 1 MiB request-body cap now holds on Cloudflare Workers for chunked uploads without a `Content-Length`. The router counts bytes as it reads and returns `413 PayloadTooLarge` as soon as a body passes the cap, instead of buffering the whole upload before checking. The 413 envelope is unchanged, and Node keeps its existing cap.
