import { resolve } from "node:path";
import { Db } from "@baerly/server";
import { LocalFsStorage, ensureTable } from "@baerly/dev";
import type { Ticket } from "../../../types.ts";

const APP = "helpdesk";
const TENANT = "helpdesk-demo";

const storage = new LocalFsStorage({
  root: resolve(import.meta.dirname, "../../../.baerly-data"),
});
await ensureTable(storage, { app: APP, tenant: TENANT, table: "tickets" });

const tickets = Db.create({ storage, app: APP, tenant: TENANT }).table<Ticket>("tickets");

if ((await tickets.count()) > 0) {
  console.log("tickets table already populated; skipping seed");
  process.exit(0);
}

const DEMO: ReadonlyArray<Omit<Ticket, "_id">> = [
  {
    title: "Login page returns 500",
    status: "open",
    assignee: "ops",
    priority: "high",
    created_at: "2026-05-10T09:00:00Z",
  },
  {
    title: "Add CSV export",
    status: "in_progress",
    assignee: "platform",
    priority: "med",
    created_at: "2026-05-10T10:00:00Z",
  },
  {
    title: "Onboarding email typo",
    status: "closed",
    assignee: "growth",
    priority: "low",
    created_at: "2026-05-09T15:00:00Z",
  },
  {
    title: "Cache headers wrong on /api/me",
    status: "open",
    assignee: "platform",
    priority: "med",
    created_at: "2026-05-11T08:00:00Z",
  },
  {
    title: "Dark mode flash on first paint",
    status: "open",
    assignee: "frontend",
    priority: "low",
    created_at: "2026-05-11T09:30:00Z",
  },
];

for (const t of DEMO) {
  const { _id } = await tickets.insert(t);
  console.log(`seeded ${_id}: ${t.title}`);
}
