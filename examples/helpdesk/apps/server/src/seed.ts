import { createBaerlyClient } from "@baerly/client";
import type { JSONArraylessObject } from "@baerly/protocol";

interface Ticket extends JSONArraylessObject {
  readonly _id: string;
  readonly title: string;
  readonly status: "open" | "in_progress" | "closed";
  readonly assignee: string;
  readonly priority: "low" | "med" | "high";
  readonly created_at: string;
}

const PORT = Number(process.env.PORT ?? 3000);
const SECRET = process.env.HELPDESK_SECRET ?? "dev-helpdesk-secret";
const client = createBaerlyClient({
  baseUrl: `http://localhost:${PORT}`,
  headers: { Authorization: `Bearer ${SECRET}` },
});

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

// Idempotent: only seed when the table is empty.
const existing = await client.table<Ticket>("tickets").where({}).count();
if (existing > 0) {
  console.log(`tickets table already has ${existing} rows; skipping seed`);
} else {
  for (const t of DEMO) {
    const { _id } = await client.table<Ticket>("tickets").insert(t);
    console.log(`seeded ${_id}: ${t.title}`);
  }
}
