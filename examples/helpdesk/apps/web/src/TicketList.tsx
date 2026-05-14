import { useEffect, useState } from "react";
import { useChanges } from "@baerly/client/react";
import { client } from "./client.ts";
import { STATUSES, type Ticket } from "../../../types.ts";

type Filter = "all" | Ticket["status"];

export const TicketList = ({ onOpen }: { onOpen: (id: string) => void }): React.JSX.Element => {
  const [rows, setRows] = useState<readonly Ticket[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const { events, error } = useChanges(client, "tickets");

  useEffect(() => {
    void (async () => {
      const tickets = client.table<Ticket>("tickets");
      const next = await (filter === "all"
        ? tickets.where({}).all()
        : tickets.where({ status: filter }).all());
      setRows(next);
    })();
  }, [events, filter]);

  if (error !== undefined) return <p style={{ color: "crimson" }}>Error: {error.message}</p>;

  return (
    <>
      <div style={{ marginBottom: 12 }}>
        <label>
          Filter:&nbsp;
          <select value={filter} onChange={(e) => setFilter(e.target.value as Filter)}>
            <option value="all">all</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
      </div>
      {rows.length === 0 ? (
        <p>No tickets. Click "+ New ticket".</p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left" }}>Title</th>
              <th style={{ textAlign: "left" }}>Status</th>
              <th style={{ textAlign: "left" }}>Assignee</th>
              <th style={{ textAlign: "left" }}>Priority</th>
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
      )}
    </>
  );
};
