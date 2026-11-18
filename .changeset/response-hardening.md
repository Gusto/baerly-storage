---
"@gusto/baerly-storage": patch
---

Three small hardening changes on the Node and Cloudflare hosts:

- An inbound `x-request-id` is used as the log line's `request_id` only when it is at most 128 characters of letters, digits and `_ . : / + = @ -`. Anything else (whitespace, quotes, control or non-ASCII characters, or a longer value) is replaced with a generated id, so a caller cannot forge or bloat log lines through the header.
- Every response from `baerlyNode` and `baerlyWorker`, including static assets served from `webRoot`, carries `X-Content-Type-Options: nosniff`.
- `fromEksPodIdentity()` (and `fromEks()` on its Pod Identity branch) throws `InvalidConfig` when `AWS_CONTAINER_CREDENTIALS_FULL_URI` is not an http(s) URL on loopback, `169.254.170.2`, `169.254.170.23` or `[fd00:ec2::23]`, before reading the token, so the token is never sent to another host.
