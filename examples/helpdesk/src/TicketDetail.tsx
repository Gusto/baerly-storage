import { useLiveDocument } from "baerly-storage/client/react";
import { client } from "./client.ts";
import type { Ticket } from "../types.ts";

interface Props {
  id: string;
  onEdit: () => void;
  onBack: () => void;
}

export const TicketDetail = ({ id, onEdit, onBack }: Props): React.JSX.Element => {
  const result = useLiveDocument<Ticket>(client, "tickets", id);

  if (result.status === "error") {
    return <p style={{ color: "crimson" }}>Error: {result.error.message}</p>;
  }
  if (result.status === "loading") {
    return <p>Loading…</p>;
  }
  if (result.status === "missing") {
    return <p>Not found.</p>;
  }
  const t = result.row;

  return (
    <div>
      <button onClick={onBack}>← Back</button>
      <h2>{t.title}</h2>
      <dl>
        <dt>Status</dt>
        <dd>{t.status}</dd>
        <dt>Assignee</dt>
        <dd>{t.assignee}</dd>
        <dt>Priority</dt>
        <dd>{t.priority}</dd>
        <dt>Created</dt>
        <dd>{t.created_at}</dd>
      </dl>
      <button onClick={onEdit}>Edit</button>
      <button
        style={{ marginLeft: 8, color: "crimson" }}
        onClick={async () => {
          if (!window.confirm("Delete this ticket?")) {
            return;
          }
          await client.table<Ticket>("tickets").where({ _id: id }).delete();
          onBack();
        }}
      >
        Delete
      </button>
    </div>
  );
};
