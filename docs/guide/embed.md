---
title: Embed by hand
audience: integrator
summary: A ~30-line snippet for embedding baerly-storage in an existing Node app, bypassing the create-baerly scaffold.
last-reviewed: 2026-05-21
tags: [embed, node, integrator]
related: ["../../README.md", "auth.md"]
---

# Embed by hand

If you'd rather embed baerly-storage into an existing app, the kernel is
about 30 lines:

```ts
import { createServer } from "node:http";
import { getRequestListener } from "@hono/node-server";
import { createApp } from "@gusto/baerly-storage/node";
import { sharedSecret } from "@gusto/baerly-storage/auth";
import { LocalFsStorage } from "@gusto/baerly-storage/dev";

const storage = new LocalFsStorage({ root: "./.baerly-data" });
// No manifest bootstrap needed — the writer auto-provisions
// `current.json` on the first commit to each (app, tenant, table).

const app = createApp({
  app: "tickets",
  storage,
  verifier: sharedSecret({ secret: "dev-secret", tenantPrefix: "acme" }),
});
createServer(getRequestListener(app.fetch)).listen(3000);
```

For production storage backends (S3, GCS, R2) and other verifier presets,
see [`auth.md`](./auth.md) and the scaffolded templates under
[`../../examples/`](../../examples).
