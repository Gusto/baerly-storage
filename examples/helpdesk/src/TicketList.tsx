import { useState } from "react";
import { useLiveQuery } from "baerly-storage/client/react";
import { client } from "./client.ts";
import { STATUSES, type Ticket } from "../types.ts";

type Filter = "all" | Ticket["status"];

export const TicketList = ({ onOpen }: { onOpen: (id: string) => void }): React.JSX.Element => {
  const [filter, setFilter] = useState<Filter>("all");
  const result = useLiveQuery<Ticket>(
    client,
    "tickets",
    filter === "all" ? {} : { status: filter },
  );

  if (result.status === "error") {
    return <p style={{ color: "crimson" }}>Error: {result.error.message}</p>;
  }

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
      {result.status === "loading" && <p>Loading…</p>}
      {result.status === "ok" && result.rows.length === 0 && (
        <p>No tickets. Click "+ New ticket".</p>
      )}
      {result.status === "ok" && result.rows.length > 0 && (
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
            {result.rows.map((t) => (
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
