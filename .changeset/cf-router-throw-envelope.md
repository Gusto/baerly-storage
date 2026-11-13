---
"@gusto/baerly-storage": patch
---

A Cloudflare Worker now answers a throw around the router, such as a Cache API failure, with the JSON error envelope and the mapped status, and flushes one canonical line with that status, as the Node adapter does. Before, the throw was recorded as a 500 and rethrown, so workerd answered with its own error page, which the client SDK cannot parse. A throw while resolving the Worker's config, such as a missing `SHARED_SECRET`, likewise answers with a 500 `Internal` envelope that omits the setting name, and the full error is still written to the Worker's console log for the operator.
