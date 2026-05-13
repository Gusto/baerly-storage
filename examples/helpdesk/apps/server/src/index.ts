import { createServer } from "node:http";
import { resolve } from "node:path";
import { createListener } from "@baerly/adapter-node";
import { sharedSecret } from "@baerly/server/auth";
import { LocalFsStorage, ensureTable } from "@baerly/dev";

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
  console.log(`helpdesk on http://localhost:${PORT}  (bearer: ${SECRET})`);
});
