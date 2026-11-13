---
"@gusto/baerly-storage": patch
---

A Cloudflare Worker now answers a throw around the router, such as a Cache API failure, with the JSON error envelope and the mapped status, and flushes one canonical line with that status, as the Node adapter does. Before, the throw was recorded as a 500 and rethrown, so workerd answered with its own error page, which the client SDK cannot parse.
