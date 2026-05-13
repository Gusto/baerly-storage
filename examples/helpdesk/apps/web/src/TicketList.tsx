/* eslint-disable no-underscore-dangle -- `_id` is the locked
   primary-key field on every Baerly document (see
   `packages/protocol/src/db.ts`). */
import { useEffect, useState } from "react";
import { useChanges } from "@baerly/client/react";
import { client } from "./client.ts";
import type { Ticket } from "./tickets.ts";

export const TicketList = ({ onOpen }: { onOpen: (id: string) => void }): React.JSX.Element => {
  const [rows, setRows] = useState<readonly Ticket[]>([]);
  const [loading, setLoading] = useState(true);

  // Initial fetch + refetch on log events. Cheaper than threading
  // changes through useReducer for this example; production apps
  // typically use TanStack Query or SWR for the cache.
  const { events, error } = useChanges(client, "tickets");

  useEffect(() => {
    void (async () => {
      setLoading(true);
      const all = await client.table<Ticket>("tickets").where({}).all();
      setRows(all);
      setLoading(false);
    })();
  }, [events]); // refetch whenever a log event lands.

  if (loading && rows.length === 0) return <p>Loading…</p>;
  if (error !== undefined) return <p style={{ color: "crimson" }}>Error: {error.message}</p>;
  if (rows.length === 0) return <p>No tickets yet. Click "+ New ticket".</p>;

  return (
    <table style={{ width: "100%", borderCollapse: "collapse" }}>
      <thead>
        <tr>
          <th align="left">Title</th>
          <th align="left">Status</th>
          <th align="left">Assignee</th>
          <th align="left">Priority</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((t) => (
          <tr key={t._id} style={{ cursor: "pointer" }} onClick={() => onOpen(t._id)}>
            <td>{t.title}</td>
            <td>{t.status}</td>
            <td>{t.assignee}</td>
            <td>{t.priority}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};
