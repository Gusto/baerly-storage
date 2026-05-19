import { z } from "zod";
import { defineConfig } from "baerly-storage/config";

/**
 * Zod schema for one ticket. Source of truth for both the runtime
 * `SchemaValidator` consumed by `baerly-storage`'s writer and the
 * compile-time `Ticket` row type imported by the UI.
 */
export const TicketSchema = z.object({
  _id: z.string(),
  title: z.string().min(1),
  status: z.enum(["open", "in_progress", "closed"]),
  priority: z.enum(["low", "med", "high"]),
  assignee: z.string(),
  created_at: z.string(),
});

export default defineConfig({
  app: "helpdesk-cloudflare",
  tenant: "helpdesk-demo",
  target: "cloudflare",
  domain: undefined,
  collections: {
    tickets: { schema: TicketSchema },
  },
});
