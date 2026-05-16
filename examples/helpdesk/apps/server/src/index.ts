import { createServer } from "node:http";
import { resolve } from "node:path";
import { createListener } from "@baerly/adapter-node";
import { sharedSecret } from "@baerly/server/auth";
import { LocalFsStorage, ensureTable, printDevBanner } from "@baerly/dev";

const PORT = Number(process.env.PORT ?? 3000);
const SECRET = process.env.HELPDESK_SECRET ?? "dev-helpdesk-secret";
const APP = "helpdesk";
const TENANT = "helpdesk-demo";

const storage = new LocalFsStorage({
  root: resolve(import.meta.dirname, "../../../.baerly-data"),
});
await ensureTable(storage, { app: APP, tenant: TENANT, table: "tickets" });

const listener = createListener({
  app: APP,
  storage,
  verifier: sharedSecret({ secret: SECRET, tenantPrefix: TENANT }),
});

createServer(listener).listen(PORT, () => {
  printDevBanner({
    name: "helpdesk",
    primaryUrl: { label: "app", url: "http://localhost:5173" },
    apiUrl: { label: "api", url: `http://localhost:${PORT}`, note: "proxied via /v1" },
    hints: [
      { key: "data", value: ".baerly-data/" },
      { key: "bearer", value: `${SECRET}  (dev only)` },
      { key: "reset", value: "pnpm reset" },
    ],
  });
});
