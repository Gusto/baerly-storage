# baerly-storage

A vendorless document database that runs over any S3-compatible
storage API. The data lives in *your* bucket; mechanical export to
SQL is a first-class feature, not an afterthought.

> Status: approaching stable. The protocol kernel and HTTP server
> are landed; Day-1 templates ship for Cloudflare Workers and
> self-hosted Node. Delivery wrappers (MCP, deploy scaffold) are
> the remaining open work.

Tested with S3, Backblaze, R2 and self-hosted Minio.

## Quick start

```ts
import { createServer } from "node:http";
import { createListener } from "@baerly/adapter-node";
import { sharedSecret } from "@baerly/server/auth";
import { LocalFsStorage, ensureTable } from "@baerly/dev";

const storage = new LocalFsStorage({ root: "./.baerly-data" });
await ensureTable(storage, { app: "tickets", tenant: "acme", table: "items" });

const listener = createListener({
  app: "tickets",
  storage,
  verifier: sharedSecret({ secret: "dev-secret", tenantPrefix: "acme" }),
});
createServer(listener).listen(3000);
```

For a runnable, multi-tab demo see [`examples/helpdesk/`](./examples/helpdesk).

## Where things live

- [`CLAUDE.md`](./CLAUDE.md) — agent entry point (also the fastest
  map for human contributors). `AGENTS.md` is a symlink to this
  file, so tools that read either name see the same content.
- [`docs/README.md`](./docs/README.md) — topic map: architecture,
  conventions, ADRs, protocol specs, operating procedures.
- [`examples/helpdesk/`](./examples/helpdesk) — runnable demo
  (90-second start, multi-tab live updates via `/v1/since`).

## Authorization

There is no built-in authorization. Every use-case needs different
authorization, and a malicious user could sabotage the manifest
file given unrestricted write access — but not all use-cases have
malicious users. A few options:

- Share access keys only with trusted personnel.
- If using S3 + IAM, issue STS tokens scoped to a sub-path per
  user/team.
- For public use, front the bucket with a trusted server (e.g. a
  Cloudflare Worker) that authenticates the caller and validates
  manifest changes before passthrough.

For starting points, see
[`packages/server/src/auth/presets/`](./packages/server/src/auth/presets/)
(shared-secret, Cloudflare Access, bearer-JWT, IP allowlist,
AWS IAM SigV4).
