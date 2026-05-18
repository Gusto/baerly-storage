import { resolve } from "node:path";
import { LocalFsStorage, ensureTable } from "baerly-storage/dev";
import { Db } from "baerly-storage";
import { seedTickets } from "./seed.ts";

const APP = "helpdesk";
const TENANT = "helpdesk-demo";

const storage = new LocalFsStorage({
  root: resolve(import.meta.dirname, "../../.baerly-data"),
});
await ensureTable(storage, { app: APP, tenant: TENANT, table: "tickets" });
const db = Db.create({ storage, app: APP, tenant: TENANT });
await seedTickets(db);
