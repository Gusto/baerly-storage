---
"@gusto/baerly-storage": patch
---

`baerly deploy --target=cloudflare` no longer probes `wrangler deploy --help` for the experimental `--x-provision` flag or prints "wrangler --x-provision unavailable". It always creates any missing declared R2 bucket with `wrangler r2 bucket create`, then runs a plain `wrangler deploy`; Wrangler 4.45+ provisions declared buckets on deploy itself. The Cloudflare scaffolds now set the `enable_request_signal` compatibility flag so `GET /v1/since` sees client disconnects and settles the long-poll, matching the Node adapter. The flag becomes the default at `compatibility_date` 2026-11-17, so drop it when you move the date past that.
